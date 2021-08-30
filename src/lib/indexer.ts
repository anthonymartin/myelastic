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
    this.client = new ElasticSearchClient({
      node: this.config.elasticsearch_url || process.env.elasticsearch_url,
      auth: process.env.elasticsearch_api_key
        ? {
            apiKey: process.env.elasticsearch_api_key,
          }
        : undefined,
    });
  }
  public async start() {
    const [indexer, startTime, query] = await this.init();
    this.datasource.query(
      query,
      async function (error, results) {
        if (error) throw error;
        if (indexer.config.useReducer) {
          results = indexer.reduce(results);
        }
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
    const getIndexName = (row) => {
      return this.grouperFn
        ? this.getIndex(this.grouperFn(row))
        : this.getIndex(null);
    };
    const groupedCollection = collection.map((row) => {
      if (this.config.explicitMapping == true) {
        row = pick(row, Object.keys(this.config.mappings));
      }
      indexer.groups.add(getIndexName(row));
      return [{ index: { _index: getIndexName(row) } }, row];
    });
    return groupedCollection;
  }
  public indexByDate(field: string, format: string) {
    this.grouperFn = (row) => {
      return `${moment(row[field]).format(format)}`;
    };
    return this;
  }
  public async bulkIndex(collection): Promise<this> {
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
      } | total batches left ${
        this.stats.totalBatches - (this.stats.batchesIndexed + 1)
      }`,
    );
  }
  private async doBulkIndex(collection: GroupedCollection, batch) {
    this.displayStatus(collection);
    const { body: bulkResponse } = await this.client.bulk({
      refresh: 'true',
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

  public async deleteIndex(index) {
    try {
      const { body } = await this.client.indices.delete({ index: index });
      if (body.acknowledged == true) {
        this.stats.deletedIndices.add(index);
        console.log(`Deleted Index ${index}`);
      }
    } catch (e) {
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
    const mutatedCollection = collection.map((row) => {
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
            settings: this.config.settings,
          },
        },
        { ignore: [400] },
      );
      try {
        if (body.acknowledged || body.status == 400)
          this.stats.createdIndices.add(indexName);
      } catch (e) {
        console.error(`There was a problem creating index: ${indexName}`);
        console.error(e);
        process.exit(1);
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
  /**
   * define the mappings to be used by the index. Usually elastic search will define these mappings automatically
   * but you can define your own for advanced usage if the default mappings are not enough
   * e.g.
   * {
   *    location: { type: "geo_point" },
   *    title: { type: "text" },
   *    description: {
   *      type: "text"
   *      analyzer: "standard",
   *      fields: {
   *        english: {
   *          type: "text",
   *          analyzer: "custom_analyzer"
   *        }
   *      }
   *    }
   * },
   */
  mappings?: { [key: string]: object };

  /**
   * This can be a MySQL query or a mongo filter
   */
  query?: string | any;

  /**
   * The collection used for mongo queries
   */
  collection?: string; // used for mongo collection queries

  /**
   * Alias for indexName
   */
  index: string; //alias for indexName

  /**
   * This is the name of the elastic search index
   */
  indexName?: string;

  /**
   * This is the number of documents/records to include in each bulk index request
   */
  batchSize?: number;

  /**
   * When using the {lastIndexedId} variable in a query (only for MySQL), this property defines the id column to use in the database
   */
  id?: string;

  /**
   * If set to true, the indexer will only index properties that have been defined in the mappings property of the IndexerConfig
   */
  explicitMapping?: boolean;

  /**
   * If set to true, the indexer will delete the existing index if it exists and create a new one before indexing data
   **/
  reindex?: boolean;

  /**
   * The reducer will receive the results of a query as an input and the output will be subsequently indexed
   */
  useReducer?: boolean;

  /**
   * Elasticsearch url here can override the one defined in the environment variable
   */
  elasticsearch_url?: string;

  /**
   * used for index settings such as defining analyzers: https://www.elastic.co/guide/en/elasticsearch/reference/7.7/configuring-analyzers.html
   * see also: https://www.elastic.co/guide/en/elasticsearch/reference/7.7/index-modules.html
   * this is passed to client.indices.create body property: https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/api-reference.html#_indices_create
   */
  settings?: any;
}

export const defaultConfig: IndexerConfig = {
  batchSize: 100,
  id: 'id',
  explicitMapping: false,
  query: null,
  index: 'myelastic-index',
};

export interface GroupSet extends Set<string> {}
export interface IndicesSet extends Set<string> {}
export interface GroupedRow {
  [index: number]: { index: { _index: string } };
  any;
}
export interface GroupedCollection extends Array<GroupedRow> {}
