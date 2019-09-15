import client from '@myelastic/drivers/elasticsearch';

export default {
  command: "last-indexed [index] [field]",
  desc: "get last indexed document",
  builder: {
   index: {
      default: "_all",
      describe: "index to search"
    },
    field: {
      default: "id",
      describe: "field to sort by and return"
    }
  },
  handler: (yargs) => {
  
    let field = yargs.field;
    let index = yargs.index;
  
  
    async function run() {
      let sort = [{}];
      sort[0][`${field}`] = { order: "desc" };
      const { body } = await client.search({
        index: index,
        body: {
            _source: field,
            size: 1,
            query: {
              match_all: {},
            },
            sort
          },
      });
  
      console.log(body.hits.hits[0]._source.id);
    }
  
    run().catch(console.log);
  }
}