#!/usr/bin/env node
import { Indexer } from '../indexer';
import * as yargs from 'yargs';
import lastIndexed from "./cmds/lastIndexed";
import deleteCmd from "./cmds/delete";

yargs
  .command(lastIndexed)
  .command(deleteCmd)
  .demandCommand()
  .help()
  .wrap(72).argv;

  
