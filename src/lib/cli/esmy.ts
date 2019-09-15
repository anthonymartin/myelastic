#! /usr/local/bin/ts-node
import * as yargs from 'yargs'
import lastIndexed from "./cmds/lastIndexed";
import deleteCmd from "./cmds/delete";

yargs
  .command(lastIndexed)
  .command(deleteCmd)
  .demandCommand()
  .help()
  .wrap(72).argv;

  
