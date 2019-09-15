import { Client } from '@elastic/elasticsearch';
export default {
  command: "delete [index]",
  desc: "delete an index",
  builder: {
   index: {
      default: false,
      describe: "index to delete"
    },
  },
  handler: (yargs) => {
    const esClient = new Client({
      node:
        process.env.elasticsearch
    });
    const index = yargs.index;
    async function run() {
      esClient.indices.delete({index: index});
    }
    run().catch(console.log);
  }
}