import client from '../../drivers/elasticsearch';
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
    const index = yargs.index;
    async function run() {
      client.indices.delete({index: index});
    }
    run().catch(console.log);
  }
}