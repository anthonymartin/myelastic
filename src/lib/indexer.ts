import 'module-alias/register';
require('dotenv').config();
import * as _ from 'underscore';
import * as moment from "moment";
import mysql from '@myelastic/drivers/mysql';
import elasticSearchClient from '@myelastic/drivers/elasticsearch';
import lastIndexed from '@myelastic/cli/cmds/lastIndexed';


export class Indexer {
  public indexName: string;
  public groupedIndices = false; // if true, will append group to index name. e.g. indexName-2019-01-23
  protected client;
  protected query: string;
  protected mappings: Map<string, any> | null = null;
  protected grouperFn: Function;
  protected batchSize: number = 100;
  protected mutators: Function[] = [];
  protected createdIndices: Set<string> = new Set;
  protected groups: Set<string> = new Set;
  protected id: string;


  public constructor(config) {
    mysql.connect();
    this.client = elasticSearchClient;
    this.mappings = config.mappings ? config.mappings : this.mappings;
    this.query = config.query ? config.query : this.query;
    this.indexName = config.index ? config.index : this.indexName;
    this.groupedIndices = config.groupedIndices ? config.groupedIndices : this.groupedIndices;
    this.batchSize = config.batchSize ? config.batchSize : this.batchSize;
    this.id = config.id ? config.id : this.id;
  }
  public async index() {
    const query = await this.generateQuery();
    const indexer = this;
    mysql.query(query, async function(error, results, fields) {
      if (error) throw error;
      indexer.bulkIndex(results);
      mysql.end();
    });
  }
  public getGroup(grouper: Function): this {
    this.grouperFn = grouper;
    return this;
  }
  protected getBatchesFromQueryResults(collection) {
    if (this.batchSize) {
      return _.chunk(collection, this.batchSize);
    }
  }
  protected applyGroup(collection): GroupedBatch {
    const getIndexName = (row) => {
      return this.grouperFn ? this.getIndex(this.grouperFn(row)) : this.getIndex(null)
    };
    const indexer = this;
    const groupedBatch = collection.reduce((acc, row) => {
      let grouped = [ {index: { _index: getIndexName(row) } }, row];
      indexer.groups.add(getIndexName(row));
      acc.push(grouped);
      return acc;
    }, []);

    return groupedBatch;
  }
  public groupByDate(field, format) {
    this.groupedIndices = true;
    this.grouperFn = (row) => {
      return `${moment(row[field]).format(format)}`;
    }
    return this;
  }
  protected async bulkIndex(collection): Promise<this> {
    if (!this.groupedIndices) {
      await this.createIndex(null);
    }
    const batches = this.getBatchesFromQueryResults(collection);
    for (let batch in batches) {
      const [groups, transformedBatch] = this.transform(batches[batch]);
      await this.createIndices(groups);
      console.log(
        `Indexing batch ${batch} | total batches ${batches.length} | items in batch ${_.size(batches[batch])}
      `);
      const { body: bulkResponse } = await this.client.bulk({
        refresh: true,
        body: _.flatten(transformedBatch),
      });
      this.handleResponse(bulkResponse, batches[batch]);
    }
    return this;
  }
  protected async createIndices(groups: Set<string>) {
    for (const group of groups) {
      await this.createIndex(group);
    };
  }
  protected transform(collection): [Groups, GroupedBatch] {
      const mutatedBatch = this.applyMutations(collection);
      const groupedBatch = this.applyGroup(mutatedBatch);
      return [this.groups, groupedBatch];

  }
  protected async generateQuery(): Promise<string> {
    if ((this.query.match(/{\lastIndexedId\}/) || []).length == 0) {
      return this.query;
    }
    let lastId = await this.getESLastIndexedRecord();
    console.log('Querying by last indexed id: ', `${lastId}`);
    return this.query.replace(/{\lastIndexedId\}/, `${lastId}`);
  }
  protected applyMutations(collection) {
    if (this.mutators.length == 0) return collection;
    const mutatedCollection = collection.reduce((acc, row) => {
      for (const mutate of this.mutators) {
        mutate(row);
      }
      acc.push(row);
      return acc;
    }, []);
    return mutatedCollection;
  }
  public addMutator(mutator): this {
    this.mutators.push(mutator);
    return this;
  }
  protected getIndex(group = null): string {
    if (!this.groupedIndices || !group) {
      return `${this.indexName}`;
    }
    return `${this.indexName}-${group}`;
  }
  protected async getESLastIndexedRecord() {
    let field = this.id ? this.id : 'id';
    let id = await lastIndexed.handler({ field: field, index: this.indexName + "*"});
    return id ? id : 0;
  }
  protected didNotCreateIndex(name) {
    return !this.createdIndices.has(name);
 }
 protected async createIndex(group=null) {
  const indexName = this.getIndex(group);
  if (this.didNotCreateIndex(indexName)) {
      console.log(`Creating Index: ${indexName}`);
      this.createdIndices.add(this.getIndex(group));
      await this.client.indices.create({
          index: this.getIndex(group),
          body: {
              mappings: {
                  properties: this.mappings
              }
          }
      }, { ignore: [400] })
      }
}
  protected getBulkString(collection) {
    const action = '{"index":{}}';
    return collection.reduce((agg, curr): string => {
      return agg.concat(`${action}\n${JSON.stringify(curr)}\n`);
    }, '');
  }
  public getIndexName(): string {
    return this.indexName;
  }

  public setIndexName(indexName: string): this {
    this.indexName = indexName;
    return this;
  }
  public setGroupedIndices(val: boolean): this {
    this.groupedIndices = val;
    return this;
  }
  public getGroupedIndices(): boolean {
    return this.groupedIndices;
  }
  protected handleResponse(response, collection) {
    if (response.errors) {
      const erroredDocuments = [];
      // The items array has the same order of the dataset we just indexed.
      // The presence of the `error` key indicates that the operation
      // that we did for the document has failed.
      response.items.forEach((action, i) => {
        const operation = Object.keys(action)[0];
        if (action[operation].error) {
          erroredDocuments.push({
            // If the status is 429 it means that you can retry the document,
            // otherwise it's very likely a mapping error, and you should
            // fix the document before to try it again.
            status: action[operation].status,
            error: action[operation].error,
            operation: collection[i * 2],
            document: collection[i * 2 + 1],
          });
        }
      });
      console.log(erroredDocuments);
    }
  }
}


export interface Groups extends Set<string> {}
export interface GroupedRow { 
  [index: number]: { index: {_index: string }}, any;
};
export interface GroupedBatch extends Array<GroupedRow> {}