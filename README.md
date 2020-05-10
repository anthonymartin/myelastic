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
  index: 'users', // this will be the name of the index in elasticsearch
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
const config = {
  index: string // the name of your index
  query:  string // the results of this query will be indexed
  collection: string // the name of the mongodb collection
  batchSize: number // defaults to 100
  id: number | date // defaults to 'id' - the `{lastIndexedId}` query variable is mapped to this field. supports numerical ids and timestamps
  mappings: {} // @see https://www.elastic.co/guide/en/elasticsearch/reference/current/mapping.html
}
