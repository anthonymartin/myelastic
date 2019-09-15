#!/bin/node
const fs = require('fs');

const cwd = process.env.INIT_CWD
const envFile = cwd + "/node_modules/@myelastic/indexer/.env.example";
try {
  if (fs.existsSync(cwd + "/.env")) {
    // let the user add their own environment variables
  } else {
    fs.copyFileSync(envFile, cwd + "/.env");
  } 
} catch (e) {

}
