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
  handler: async (yargs): Promise<number|null> => {
  
    let field = yargs.field;
    let index = yargs.index;
  
  
    async function run() {
      let id = null;
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
  
      try {
        id = body.hits.hits[0]._source.id;
      } catch {
        console.log(`Last Indexed ID not found. Does ${index} [index] and ${field} [field] exist?`);
      }
      return id;
    }
  
    return run();
  }
}