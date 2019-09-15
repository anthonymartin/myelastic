#!/bin/node
const fs = require('fs');

const cwd = process.env.INIT_CWD
const binDir = cwd + "/bin";
const envFile = cwd + "/node_modules/@myelastic/indexer/.env.example";
const cliFile = cwd + "/node_modules/@myelastic/indexer/lib/cli/myelastic.js";

const copyEnvFile = function () {
  if (fs.existsSync(cwd + "/.env")) {
    // let the user add their own environment variables
  } else {
    fs.copyFileSync(envFile, cwd + "/.env");
  }
}

const copyCliFile = function () {
  if (fs.existsSync(binDir)) {
    fs.copyFileSync(cliFile, binDir + '/myelastic');
    fs.chmodSync(binDir + '/myelastic', "755");
  } else {
    fs.mkdirSync(binDir);
    fs.copyFileSync(cliFile, binDir + '/myelastic');
    fs.chmodSync(binDir + '/myelastic', "755");
  }
}
try {
  copyEnvFile();
  // copyCliFile();
} catch (e) {

}
