import 'module-alias/register';
require('dotenv').config();
import * as _ from 'underscore';
import mysql from '@myelastic/drivers/mysql';
import client from '@myelastic/drivers/elasticsearch';

export class Indexer {
  public indexName: string;
  public groupedIndices = false; // if true, will append group to index name. e.g. indexName-2019-01-23
  protected client;
  protected query: string;
  protected mappings: Map<string, any> | null = null;
  protected batchFn: Function;
  protected batchSize: number;
  protected mutators: Function[] = [];

  public constructor(config) {
    mysql.connect();
    this.client = client;
    this.mappings = config.mappings;
    this.query = config.query;
    this.indexName = config.index;
    this.groupedIndices = config.groupedIndices;
    this.batchSize = config.batchSize;
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
  public setBatcher(batch: Function): this {
    this.batchFn = batch;
    return this;
  }
  protected getBatcher(): Function {
    if (!this.batchFn) {
      this.batchFn = row => {
        return null;
      };
    }
    return this.batchFn;
  }
  protected async bulkIndex(collection, mutate = null): Promise<this> {
    if (!this.groupedIndices) {
      this.createIndex(null);
    }
    let groups = _.groupBy(collection, row => {
      return this.batchFn(row);
    });
    for (let group in groups) {
      const mutatedGroup = this.runMutations(groups[group]);
      console.log(`indexing ${group} - ${mutatedGroup.length} records`);
      if (this.groupedIndices) {
        await this.createIndex(group);
      }
      const { body: bulkResponse } = await this.client.bulk({
        refresh: true,
        index: this.getIndex(group),
        body: this.getBulkString(mutatedGroup),
      });
      this.handleResponse(bulkResponse, groups[group]);
    }
    return this;
  }
  protected async generateQuery(): Promise<string> {
    if ((this.query.match(/{\lastInsertedId\}/) || []).length == 0) {
      return this.query;
    }
    let lastId = await this.getESLastIndexedRecord();
    console.log('Querying by last indexed id: ', lastId);
    return this.query.replace(/{\lastInsertedId\}/, lastId);
  }
  protected runMutations(collection) {
    if (this.mutators.length == 0) return collection;
    const mutatedCollection = collection.reduce((agg, row) => {
      for (let mutate of this.mutators) {
        mutate(row);
      }
      agg.push(row);
      return agg;
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
    let id = null;
    const { body } = await this.client.search({
      index: this.getIndex(null) + '*',
      body: {
        _source: 'id',
        size: 1,
        query: {
          match_all: {},
        },
        sort: [{ id: { order: 'desc' } }],
      },
    });
    try {
      id = body.hits.hits[0]._source.id;
    } catch {
      id = 0;
    }
    return id;
  }
  protected async createIndex(group) {
    return await this.client.indices.create(
      {
        index: this.getIndex(group),
        body: {
          mappings: {
            properties: this.mappings,
          },
        },
      },
      { ignore: [400] },
    );
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
