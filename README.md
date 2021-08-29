# [@myelastic/indexer - ElasticSearch Indexer for MySQL and MongoDB](https://github.com/anthonymartin/myelastic)

A simple but powerful way to create elasticsearch indexes from your MySQL and MongoDB data. This package will save you the hassle of writing your elasticsearch import scripts from scratch. This indexer offers a declarative configuration and easily extensible interface to make indexing data from MySQL or MongoDB a breeze.

## Features:

- Easy to get started with minimum configuration
- Transform your data before it is indexed using the `addMutator` callback function
- Query variables: use `{lastIndexedId}` variable in your MySQL query to get the last indexed document of your index
- Full typescript and javascript support

## Installation

`npm install @myelastic/indexer`

or

`yarn add @myelastic/indexer`

## Usage

### Set your environment variables in .env

```ini
elasticsearch_url=
elasticsearch_api_key=

// mysql
mysql_host=
mysql_user=
mysql_password=
mysql_database=

// mongo
mongodb_url=
mongodb_database=
```

### Quick Start

Typescript:

```typescript
import { Indexer } from '@myelastic/indexer';

const config = {
  index: 'invoices',
  query: 'select * from invoices',
};

new Indexer(config).start();
```

Javascript:

```javascript
const { Indexer } = require('@myelastic/indexer');

const config = {
  index: 'invoices',
  query: 'select * from invoices',
};

new Indexer(config).start();
```

## MongoDB example

First, make sure your environment variables are set:
```
mongodb_url=
mongodb_database=
```

Your indexer may look like this:

```typescript
import { Indexer } from '@myelastic/indexer';
const config = {
  index: 'users-index', // this will be the name of the index in elasticsearch
  collection: 'users', // this is the name of the mongodb collection we want to index
  batchSize: 1000, // how many documents to process at once
  query: {}, // the filter for your query: @see https://www.npmjs.com/package/mongodb#find-documents-with-a-query-filter
};

new Indexer(config)
.start();
```

## Adanced Configuration

### Mapping

You'll sometimes find you need to explicitly define your elasticsearch index mappings. You can define those in your configuration:

```javascript
const config = {
  // ...
  mappings: {
    amount: { type: 'float' },
    amount_paid: { type: 'float' },
    date: { type: 'date' },
  },
};
```

### Mutators

Every row of your query can be passed to a mutator function which allows you to transform the data before it is indexed.

```javascript
// our database has an IP, but let's also map the geolocation coordinates for that IP
const mutator = function (row) => {
  row.geo_location = getCoordinatesFromIP(row.ip);
};

new Indexer(config)
  .addMutator(mutator)
  .start();
```

### Indexing by Date

Index your data by date and the date in the format you provide will be appended to the index name. e.g. `indexName-2019`

```javascript
new Indexer(config)
  .indexByDate('date_field', 'YYYY')
  .start();
```

### Query variables

Use a `{lastIndexedId}` in your query to get the last indexed record for the id field specified in the configuration.

```typescript
const config = {
  index: 'invoices',
  id: 'invoice_id',
  query: 'select * from invoices where invoice_id > {lastIndexedId}',
};

new Indexer(config)
  .start();
```

### Chained Mutators

Add any number of mutators to transform your data before it is indexed

```javascript
// our database has an IP, but let's also map the geolocation coordinates for that IP
const geoLocation = function (row) => {
  row.geo_location = getCoordinatesFromIP(row.ip);
};

const timestamp = function (row) => {
  row.timestamp = new Date();
};

new Indexer(config)
 .addMutator(geoLocation)
 .addMutator(timestamp)
 .start();
```



### Configuration Options

```javascript
const config: IndexerConfig = {
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
  mappings: { [key: string]: object };

  /**
   * used for index settings such as defining analyzers: https://www.elastic.co/guide/en/elasticsearch/reference/7.7/configuring-analyzers.html
   * see also: https://www.elastic.co/guide/en/elasticsearch/reference/7.7/index-modules.html
   * this is passed to client.indices.create body property: https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/api-reference.html#_indices_create
   */
  settings: any, 

  /**
   * This can be a MySQL query or a mongo filter
   */
  query: string | any;
  
  /**
   * The collection used for mongo queries
   */
  collection: string; // used for mongo collection queries

  /**
   * Alias for indexName
   */
  index: string; //alias for indexName

  /**
   * This is the name of the elastic search index
   */
  indexName: string;

  /**
   * This is the number of documents/records to include in each bulk index request 
   */
  batchSize: number;

  /**
   * When using the {lastIndexedId} variable in a query (only for MySQL), this property defines the id column to use in the database
   */
  id: string;

  /**
   * If set to true, the indexer will only index properties that have been defined in the mappings property of the IndexerConfig
   */
  explicitMapping: boolean;

  /**
   * If set to true, the indexer will delete the existing index if it exists and create a new one before indexing data
   **/
  reindex: boolean;
  
  /**
   * The reducer will receive the results of a query as an input and the output will be subsequently indexed
   */
  useReducer: boolean;
}
```

### Advanced Example

Below is an example configuration with a custom analyzer that uses a shingle filter which is useful for creating a tag cloud in kibana with 2 to 3-word phrases.

```typescript
import { Indexer, IndexerConfig } from '@myelastic/indexer';

const config: IndexerConfig = {
  index: 'feedback',
  reindex: true,
  batchSize: 1000,
  query: 'select * from tbl_feedback',
  settings: {
    analysis: {
      analyzer: {
        shingle_analyzer: {
          type: "custom",
          tokenizer: "standard",
          filter: ["my_shingle_filter"],
        }
      },
      filter: {
        my_shingle_filter: {
          type: "shingle",
          min_shingle_size: 2,
          max_shingle_size: 3,
          output_unigrams: false,
          output_unigrams_if_no_shingles: true,
        }
      }
    }
  },
  mappings: {
    feedback: { 
      type: 'text',
      fielddata: true,
      analyzer: "shingle_analyzer",
      fields: {
        raw: {
          type: "keyword"
        }
      },
    }
  }
};

new Indexer(config).start()
```
