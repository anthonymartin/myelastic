# [@myelastic/indexer - MySQL to ElasticSearch Indexer](https://github.com/anthonymartin/myelastic)

A simple but powerful way to index your mysql data to elasticsearch.

## Features:

- Easy to get started - just define your query and the name of your index
- Use `{lastIndexedId}` in your query to get the highest numerical id in the elastic search index. This is automatically mapped to the `id` field in your indexed elastic search document
- Define your batches using the `setBatch` callback function which allows you define a group for each record.
- Transform your data before it is indexed using the `addMutator` callback function.
- Full typescript and javascript support

## Installation

`npm install @myelastic/indexer`

or

`yarn add @myelastic/indexer`

## Usage

### Set your environment variables in .env

```ini
elasticsearch_url=
mysql_host=
mysql_user=
mysql_password=
mysql_database=
```

### Simple configuration

The minimum configuration your indexer needs looks like this:

Typescript:

```typescript
import { Indexer } from '@myelastic/indexer';

const config = {
  index: 'invoices',
  query: 'select * from invoices',
};

new Indexer(config).index().catch(console.log);
```

Javascript:

```javascript
const { Indexer } = require('@myelastic/indexer');

const config = {
  index: 'invoices',
  query: 'select * from invoices',
};

new Indexer(config).index().catch(console.log);
```

## Adanced Configuration

### Mapping

You'll find sometimes you need to explicitly define your mappings for the elastic search indexes. You can define those in your configuration like this:

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

Every row of your query can be passed to a mutator function which allows you to transform the data before it is indexed. As an example, this can be useful if you want to add geolocation date to your index for visualization in Kibana.

```javascript
// our database has an IP, but let's also map the geolocation coordinates for that IP
const mutator = function (row) => {
  row.geo_location = getCoordinatesFromIP(row.ip);
};

new Indexer(config)
.addMutator(mutator)
.index().catch(console.log);
```
