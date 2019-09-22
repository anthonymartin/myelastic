#!/bin/node
const fs = require('fs');

const cwd = process.env.INIT_CWD

const getTemplateEnv = () => {
  const envFile = cwd + "/node_modules/@myelastic/indexer/.env.example";
  return envFile;
}

const getMainFile = () => {
  const main = cwd + "/node_modules/@myelastic/indexer/lib/indexer.js";
  return main;
}
const getCliFile = () => {
  const cli = cwd + "/node_modules/@myelastic/indexer/lib/cli/myelastic.js";
  return cli;
}

const copyFile = function (source, target, overwrite=false, executable=false) {
  if (fs.existsSync(target) && overwrite) {
    fs.copyFileSync(source, target);
    if (executable) {
      fs.chmodSync(target, "755");
    }
  } else {
    // do nothing since we don't want to overwrite a file
  }
}

const requireDotEnv = function (file, envReference) {
  const source = cwd + '/.env';
  const requireDotEnv = `require('dotenv').config({ path: ${envReference} });`;
  if (fs.existsSync(source) && fs.existsSync(file) && !fs.readFileSync(file).toString().match(/require\('dotenv'\)/gm)) {
    var fileLineByLine = fs.readFileSync(file).toString().match(/^.+$/gm);
    fileLineByLine[1] = fileLineByLine[1].concat(`\n${requireDotEnv}\n`);
    fs.writeFileSync(file, fileLineByLine.join("\n"));
  }
};

const copyEnvAndSetLocationInMain = () => {
  const source = getTemplateEnv();
  const target = cwd + "/.env";
  copyFile(source, target, false);
  requireDotEnv(getMainFile(), "__dirname + '/../../../../.env'");
}

const setCliEnvLocation = () => {
  const target  = getCliFile();
  requireDotEnv(target, "__dirname + '/../../../../../.env'");
}
const createBinDir = () => {
  if(!fs.existsSync(cwd + '/bin')) {
    fs.mkdirSync(cwd + '/bin');
  }
}

try {
  copyEnvAndSetLocationInMain();
  setCliEnvLocation();
} catch (e) {
  console.log(e);
}
