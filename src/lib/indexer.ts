import 'module-alias/register';
require('dotenv').config();
import * as _ from 'underscore';
import * as moment from 'moment';
import mysql = require("mysql");
import { Client } from '@elastic/elasticsearch';
import lastIndexed from '@myelastic/cli/cmds/lastIndexed';
const humanizeDuration = require('humanize-duration');

export class Indexer {
  public indexName: string;
  public groupedIndices = false; // if true, will append group to index name. e.g. indexName-2019-01-23
  protected client;
  protected query: string;
  protected mappings: Map<string, any> | null = null;
  protected grouperFn: Function;
  protected batchSize: number = 100;
  protected mutators: Function[] = [];
  protected createdIndices: IndicesSet = new Set();
  protected groups: GroupSet = new Set();
  protected id: string = 'id';
  private mysqlConnection;

  public constructor(config) {
    this.mysqlConnect();
    this.client = new Client({ node: process.env.elasticsearch_url });
    this.mappings = config.mappings ? config.mappings : this.mappings;
    this.query = config.query ? config.query : this.query;
    this.indexName = config.index ? config.index : this.indexName;
    this.batchSize = config.batchSize ? config.batchSize : this.batchSize;
    this.id = config.id ? config.id : this.id;
  }
  public async index() {
    const startTime = new Date().getTime();
    const query = await this.generateQuery();
    const indexer = this;
    this.mysqlConnection.query(query, async function(error, results, fields) {
      if (error) throw error;
      indexer.mysqlConnection.end();
      await indexer.bulkIndex(results);
      indexer.getDuration(startTime);
    });
  }
  /**
   * pass a callback which returns the index group that `row` should belong to.
   * @param grouper(row)
   */
  public assignGroup(grouper: Function): this {
    this.grouperFn = grouper;
    return this;
  }
  protected applyGroup(collection): GroupedCollection {
    const getIndexName = row => {
      return this.grouperFn ? 
        this.getIndex(this.grouperFn(row)) : this.getIndex(null);
    };
    const indexer = this;
    const groupedBatch = collection.reduce((acc, row) => {
      let grouped = [{ index: { _index: getIndexName(row) } }, row];
      indexer.groups.add(getIndexName(row));
      acc.push(grouped);
      return acc;
    }, []);

    return groupedBatch;
  }
  public indexByDate(field, format) {
    this.grouperFn = row => {
      return `${moment(row[field]).format(format)}`;
    };
    return this;
  }
  protected async bulkIndex(collection): Promise<this> {
    const batches = _.chunk(collection, this.batchSize);
    for (let batch in batches) {
      const [indices, transformedBatch] = this.transform(batches[batch]);
      await this.createIndices(indices);
      console.log(
        `Indexing batch ${batch} | total batches ${
          batches.length
        } | items in batch ${_.size(batches[batch])} | batches left `.concat(String(batches.length-1-(Number(batch))))
      );
      await this.doBulkIndex(transformedBatch, batch);
    }
    return this;
  }
  protected async doBulkIndex(collection: GroupedCollection, batch) {
    const { body: bulkResponse } = await this.client.bulk({
      refresh: true,
      body: _.flatten(collection),
    });
    this.handleResponse(bulkResponse, batch);
  }
  protected async createIndices(groups: GroupSet) {
    for (const group of groups) {
      await this.createIndex(group);
    }
  }
  protected transform(collection): [GroupSet, GroupedCollection] {
    const mutatedBatch = this.applyMutations(collection);
    const groupedBatch = this.applyGroup(mutatedBatch);
    return [this.groups, groupedBatch];
  }
  protected async generateQuery(): Promise<string> {
    if ((this.query.match(/{\lastIndexedId\}/) || []).length == 0) {
      return this.query;
    }
    let lastId = await this.getESLastIndexedRecord();
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
    if (!group) {
      return `${this.indexName}`;
    }
    return `${this.indexName}-${group}`;
  }
  protected async getESLastIndexedRecord() {
    let field = this.id ? this.id : 'id';
    let id = await lastIndexed.handler({
      field: field,
      index: this.indexName + '*',
    });
    id = id ? id : 0;
    console.log(`Querying by last indexed ${this.id}: ${id}`);
    return id;
  }
  protected didNotCreateIndex(name) {
    return !this.createdIndices.has(name);
  }
  protected async createIndex(indexName: string) {
    if (this.didNotCreateIndex(indexName)) {
      console.log(`Creating Index: ${indexName}`);
      const { body } = await this.client.indices.create(
        {
          index: indexName,
          body: {
            mappings: {
              properties: this.mappings,
            },
          },
        },
        { ignore: [400] },
      );
      try {
        if (body.acknowledged && body.index == indexName) {
          this.createdIndices.add(indexName);
        }
      } catch (e) {
        console.log(`There was a problem creating index: ${indexName}`);
        console.log(e);
        process.exit();
      }
    }
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
  protected getDuration(start) {
      const end = new Date().getTime();
      console.log (`✨  Done in: ${humanizeDuration(end-start)}`);
  }
  private mysqlConnect() {
    this.mysqlConnection = mysql.createConnection({
      host     : process.env.mysql_host,
      user     : process.env.mysql_user,
      password : process.env.mysql_password,
      database : process.env.mysql_database
    });
  }
}

export interface GroupSet extends Set<string> {}
export interface IndicesSet extends Set<string> {}
export interface GroupedRow {
  [index: number]: { index: { _index: string } };
  any;
}
export interface GroupedCollection extends Array<GroupedRow> {}
