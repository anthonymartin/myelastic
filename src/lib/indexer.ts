require('dotenv').config({ path: require('find-config')('.env') });
import { pick, chunk, flatten } from 'lodash';
import * as moment from 'moment';
import { Client as ElasticSearchClient } from '@elastic/elasticsearch';
import lastIndexed from './cli/cmds/lastIndexed';
import { MySQLDataSource } from './drivers/mysql';
import { MongoDBSource } from './drivers/mongodb';
import { DataSource } from './drivers/datasource';
const humanizeDuration = require('humanize-duration');


export class Indexer {
  private config: IndexerConfig;
  private client: ElasticSearchClient;
  private datasource: DataSource;
  private groups: GroupSet = new Set();
  private reduce: Function;
  private grouperFn: Function;
  private mutators: Function[] = [];
  private stats = {
    batchesIndexed: 0,
    recordsIndexed: 0,
    indexErrors: 0,
    totalBatches: 0,
    createdIndices: new Set() as IndicesSet,
    deletedIndices: new Set() as IndicesSet,
  };

  public constructor(config: IndexerConfig) {
    this.config = { ...defaultConfig, ...config, indexName: config.index };
    this.client = new ElasticSearchClient({ node: process.env.elasticsearch_url });
  }
  public async start() {
    const [indexer, startTime, query] = await this.init();
    this.datasource.query(
      query,
      async function(error, results) {
        if (error) throw error;
        if (indexer.config.useReducer) {
          results = indexer.reduce(results);
        }
        indexer.datasource.end();
        await indexer.bulkIndex(results);
        indexer.displayStats(startTime);
        process.exit(0);
      },
      this.config.collection,
    );
  }

  private async init(): Promise<[this, number, string]> {
    await this.connect();
    console.log(`Starting index of ${this.config.indexName}`);
    return [this, new Date().getTime(), await this.generateQuery()];
  }
  /**
   * pass a callback which returns the index group that `row` should belong to.
   * @param grouper(row)
   */
  public assignGroup(grouper: Function): this {
    this.grouperFn = grouper;
    return this;
  }

  public useCollectionReducer(reducer): this {
    this.config.useReducer = true;
    this.reduce = reducer;
    return this;
  }

  /**
   * maps group/indices to collection
   * @param collection
   */
  private applyGroup(collection): GroupedCollection {
    const indexer = this;
    const getIndexName = row => {
      return this.grouperFn
        ? this.getIndex(this.grouperFn(row))
        : this.getIndex(null);
    };
    const groupedCollection = collection.map(row => {
      if (this.config.explicitMapping == true) {
        row = pick(row, Object.keys(this.config.mappings));
      }
      indexer.groups.add(getIndexName(row));
      return [{ index: { _index: getIndexName(row) } }, row];
    });
    return groupedCollection;
  }
  public indexByDate(field: string, format: string) {
    this.grouperFn = row => {
      return `${moment(row[field]).format(format)}`;
    };
    return this;
  }
  private async bulkIndex(collection): Promise<this> {
    const batches = chunk(collection, this.config.batchSize).reverse();
    while (batches.length > 0) {
      const batch = this.getNextBatch(batches);
      const [indices, transformedBatch] = this.transform(batch);
      await this.createIndices(indices);
      await this.doBulkIndex(transformedBatch, batch);
    }
    return this;
  }
  private getNextBatch(batches) {
    this.stats.totalBatches = !this.stats.totalBatches
      ? batches.length
      : this.stats.totalBatches; // only set the total count on first iteration
    return batches.pop();
  }
  private displayStatus(collection) {
    console.log(
      `Indexing batch ${this.stats.batchesIndexed + 1} | items in batch ${
        collection.length
      } | total batches left ${this.stats.totalBatches -
        (this.stats.batchesIndexed + 1)}`,
    );
  }
  private async doBulkIndex(collection: GroupedCollection, batch) {
    this.displayStatus(collection);
    const { body: bulkResponse } = await this.client.bulk({
      refresh: "true",
      body: flatten(collection),
    });
    this.handleResponse(bulkResponse, batch);
  }
  private async createIndices(groups: GroupSet) {
    for (const index of groups) {
      if (this.config.reindex && !this.stats.deletedIndices.has(index)) {
        await this.deleteIndex(index);
      }
      await this.createIndex(index);
    }
  }

  private async deleteIndex(index) {
    try {
      const { body } = await this.client.indices.delete({ index: index });
      if (body.acknowledged == true) {
       this.stats.deletedIndices.add(index);
       console.log(`Deleted Index ${index}`);
      }
    } catch(e) {
      console.log('Could not delete index. Perhaps it does not exist.', e);
    }
  }

  /**
   * Applies mutations and groups each item in the collection with their associated index group
   * @param collection
   */
  private transform(collection): [GroupSet, GroupedCollection] {
    const mutatedCollection = this.applyMutations(collection);
    const groupedCollection = this.applyGroup(mutatedCollection);
    return [this.groups, groupedCollection];
  }
  private async generateQuery(): Promise<string> {
    if (typeof this.config.query !== 'string') {
      return this.config.query;
    }
    if ((this.config.query.match(/{\lastIndexedId\}/) || []).length == 0) {
      return this.config.query;
    }
    return this.config.query.replace(
      /{\lastIndexedId\}/,
      await this.getESLastIndexedRecord(),
    );
  }
  private applyMutations(collection) {
    if (this.mutators.length == 0) return collection;
    const mutatedCollection = collection.map(row => {
      for (const mutate of this.mutators) mutate(row);
      return row;
    });
    return mutatedCollection;
  }
  public addMutator(mutator): this {
    this.mutators.push(mutator);
    return this;
  }
  private getIndex(group = null): string {
    if (!group) return `${this.config.indexName}`;
    return `${this.config.indexName}-${group}`;
  }
  private async getESLastIndexedRecord(): Promise<string> {
    const id =
      (await lastIndexed.handler({
        field: this.config.id,
        index: this.config.indexName + '*',
      })) || 0;
    console.log(`Querying by last indexed ${this.config.id}: ${id}`);
    return `${id}`;
  }
  private didNotCreateIndex(name) {
    return !this.stats.createdIndices.has(name);
  }
  private async createIndex(indexName: string) {
    if (this.didNotCreateIndex(indexName)) {
      console.log(`Creating Index: ${indexName}`);
      const { body } = await this.client.indices.create(
        {
          index: indexName,
          body: {
            mappings: {
              properties: this.config.mappings,
            },
          },
        },
        { ignore: [400] },
      );
      try {
        if (body.acknowledged || body.status == 400)
          this.stats.createdIndices.add(indexName);
      } catch (e) {
        console.log(`There was a problem creating index: ${indexName}`);
        console.log(e);
        process.exit();
      }
    }
  }
  public getIndexName(): string {
    return this.config.indexName;
  }

  public setIndexName(indexName: string): this {
    this.config.indexName = indexName;
    return this;
  }
  private handleResponse(response, collection) {
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
          this.stats.indexErrors += 1;
        } else {
          this.stats.recordsIndexed += 1;
        }
      });
      console.log(erroredDocuments);
    } else {
      this.stats.batchesIndexed += 1;
      this.stats.recordsIndexed += collection.length;
    }
  }
  private displayStats(start) {
    const end = new Date().getTime();
    console.log(this.stats);
    console.log(`✨  Done in: ${humanizeDuration(end - start)}`);
  }
  private async connect() {
    if (this.config.collection) {
      const mongo = MongoDBSource.getInstance();
      await mongo.connect();
      this.datasource = mongo;
    } else {
      this.datasource = new MySQLDataSource();
    }
  }
}

export interface IndexerConfig {
  mappings?: { [key: string]: object };
  query: string | any;
  collection?: string; // used for mongo collection queries
  index: string; //alias for indexName
  indexName?: string;
  batchSize?: number;
  id?: string;
  explicitMapping?: boolean;
  reindex?: boolean;
  useReducer?: boolean;
}

export const defaultConfig: IndexerConfig = {
  batchSize: 100,
  id: 'id',
  explicitMapping: false,
  query: null,
  index: 'myelastic-index',
  useReducer: false,
};
export interface GroupSet extends Set<string> {}
export interface IndicesSet extends Set<string> {}
export interface GroupedRow {
  [index: number]: { index: { _index: string } };
  any;
}
export interface GroupedCollection extends Array<GroupedRow> {}
