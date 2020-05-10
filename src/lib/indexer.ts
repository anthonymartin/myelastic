require('dotenv').config({ path: require('find-config')('.env') });
import { pick, chunk, flatten } from 'lodash';
import * as moment from 'moment';
import { Client } from '@elastic/elasticsearch';
import lastIndexed from './cli/cmds/lastIndexed';
import { MySQLDataSource } from './drivers/mysql';
import { MongoDBSource } from './drivers/mongodb';
import { DataSource } from './drivers/datasource';
const humanizeDuration = require('humanize-duration');

export class Indexer implements IndexerConfig {
  public index: string; // alias for indexname
  public query: string;
  public mappings: Map<string, any> | null = null;
  public batchSize: number = 100;
  public id: string = 'id';
  public explicitMapping: boolean = false;
  public reindex: boolean = false;
  public collection: string | null = null;
  protected indexName: string;
  protected client;
  protected grouperFn: Function;
  protected mutators: Function[] = [];
  protected createdIndices: IndicesSet = new Set();
  protected groups: GroupSet = new Set();
  private deletedIndices = new Set();
  private reduce: Function;
  private useReducer: boolean;
  private connection: DataSource;
  private stats = {
    batchesIndexed: 0,
    recordsIndexed: 0,
    indexErrors: 0,
    totalBatches: 0
  };

  public constructor(config) {
    this.setConfigValues(config);
    this.client = new Client({ node: process.env.elasticsearch_url });
  }
  private setConfigValues(config: IndexerConfig) {
    this.mappings = config.mappings || this.mappings;
    this.collection = config.collection || this.collection;
    this.explicitMapping = config.explicitMapping || this.explicitMapping;
    this.query = config.query || this.query;
    this.indexName = config.index || this.indexName;
    this.batchSize = config.batchSize || this.batchSize;
    this.reindex = config.reindex || this.reindex;
    this.id = config.id || this.id;
  }
  public async start() {
    const [indexer, startTime, query] = await this.init();
    this.connection.query(query, async function(error, results) {
      if (error) throw error;
      if (indexer.useReducer) {
        results = indexer.reduce(results);
      }
      indexer.connection.end();
      await indexer.bulkIndex(results);
      indexer.displayStats(startTime);
    }, this.collection);
  }

  private async init(): Promise<[this, number, string]> {
    await this.connect();
    console.log(`Starting index of ${this.indexName}`);
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
    this.useReducer = true;
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
      return this.grouperFn ? 
        this.getIndex(this.grouperFn(row)) : this.getIndex(null);
    };
    const groupedCollection = collection.map((row) => {
      if (this.explicitMapping == true) {
        row = pick(row, Object.keys(this.mappings));
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
  protected async bulkIndex(collection): Promise<this> {
    const batches = chunk(collection, this.batchSize).reverse();
    while (batches.length > 0) {
      const batch = this.getNextBatch(batches);
      const [indices, transformedBatch] = this.transform(batch);
      await this.createIndices(indices);
      await this.doBulkIndex(transformedBatch, batch);
    }
    return this;
  }
  private getNextBatch(batches) {
    this.stats.totalBatches = !this.stats.totalBatches ? 
      batches.length :  this.stats.totalBatches; // only set the total count on first iteration
    return batches.pop();
  }
  private displayStatus(collection) {
    process.stdout.clearLine(0);
    console.log(
      `Indexing batch ${this.stats.batchesIndexed+1} | items in batch ${collection.length} | total batches left ${this.stats.totalBatches - (this.stats.batchesIndexed + 1)}`
    );
  }
  protected async doBulkIndex(collection: GroupedCollection, batch) {
    this.displayStatus(collection);
    const { body: bulkResponse } = await this.client.bulk({
      refresh: true,
      body: flatten(collection),
    });
    this.handleResponse(bulkResponse, batch);
  }
  private async createIndices(groups: GroupSet) {
    for (const index of groups) {
      if (this.reindex && !this.deletedIndices.has(index)) {
        await this.deleteIndex(index);
      }
      await this.createIndex(index);
    }
  }

  private async deleteIndex(index) {
    this.deletedIndices.add(index)
    const { body } = await this.client.indices.delete({index: index})
    if (body.acknowledged == true) {
      console.log(`Deleted Index ${index}`);
    }
  }

  /**
   * Applies mutations and groups each item in the collection with their associated index group
   * @param collection 
   */
  protected transform(collection): [GroupSet, GroupedCollection] {
    const mutatedCollection = this.applyMutations(collection);
    const groupedCollection = this.applyGroup(mutatedCollection);
    return [this.groups, groupedCollection];
  }
  protected async generateQuery(): Promise<string> {
    if (typeof this.query !== 'string') {
      return this.query;
    }
    if ((this.query.match(/{\lastIndexedId\}/) || []).length == 0) {
      return this.query;
    }
    return this.query.replace(/{\lastIndexedId\}/, await this.getESLastIndexedRecord());
  }
  protected applyMutations(collection) {
    if (this.mutators.length == 0) return collection;
    const mutatedCollection = collection.map((row) => {
      for (const mutate of this.mutators)
        mutate(row);
      return row;
    });
    return mutatedCollection;
  }
  public addMutator(mutator): this {
    this.mutators.push(mutator);
    return this;
  }
  protected getIndex(group = null): string {
    if (!group)
      return `${this.indexName}`;
    return `${this.indexName}-${group}`;
  }
  protected async getESLastIndexedRecord(): Promise<string> {
    const id = await lastIndexed.handler({
      field: this.id,
      index: this.indexName + '*',
    }) || 0;
    console.log(`Querying by last indexed ${this.id}: ${id}`);
    return `${id}`;
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
        if (body.acknowledged || body.status == 400)
          this.createdIndices.add(indexName);
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
  protected displayStats(start) {
      const end = new Date().getTime();
      console.log(this.stats);
      console.log (`✨  Done in: ${humanizeDuration(end-start)}`);
  }
  protected async connect() {
    if (this.collection) {
      const mongo = MongoDBSource.getInstance();
      await mongo.connect();
      this.connection = mongo;
    } else {
      this.connection = new MySQLDataSource();
    }
  }

}

export interface IndexerConfig {
  mappings: Map<string, any> | null,
  query: string,
  collection: string | null, // used for mongo collection queries
  index: string;
  batchSize: number,
  id: string;
  explicitMapping: boolean;
  reindex: boolean;
}
export interface GroupSet extends Set<string> {}
export interface IndicesSet extends Set<string> {}
export interface GroupedRow {
  [index: number]: { index: { _index: string } };
  any;
}
export interface GroupedCollection extends Array<GroupedRow> {}
