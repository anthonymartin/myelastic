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

const setDotEnvLocation = function () {
  const dotEnv = cwd + '/.env';
  const main = cwd + "/node_modules/@myelastic/indexer/lib/indexer.js";
  const requireDotEnv = `require('dotenv').config({ path: __dirname + '/../../../../.env' });`;
  if (fs.existsSync(dotEnv) && fs.existsSync(main) && !fs.readFileSync(main).toString().match(/require\('dotenv'\)/gm)) {
    var mainLineByLine = require('fs').readFileSync(main).toString().match(/^.+$/gm);
    mainLineByLine[1] = mainLineByLine[1].concat(`\n${requireDotEnv}\n`);
    fs.writeFileSync(main, mainLineByLine.join("\n"));
  }
};

try {
  copyEnvFile();
  setDotEnvLocation();
  // copyCliFile();
} catch (e) {
  console.log(e);
}
