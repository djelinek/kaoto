'use strict';

const download = require('mvn-artifact-download').default;
const fs = require('fs');
const path = require('path');

const LSP_SERVER_VERSION = '1.35.0';
const MAVEN_CENTRAL_URL = 'https://repo1.maven.org/maven2/';
const ARTIFACT = 'com.github.camel-tooling:camel-lsp-server:' + LSP_SERVER_VERSION;
const JARS_DIR = path.join(__dirname, '..', 'jars');

if (!fs.existsSync(JARS_DIR)) {
  fs.mkdirSync(JARS_DIR, { recursive: true });
}

const targetPath = path.join(JARS_DIR, 'language-server.jar');

if (fs.existsSync(targetPath)) {
  console.log('Camel LSP server JAR already exists, skipping download.');
  process.exit(0);
}

console.log(`Downloading Camel LSP server ${LSP_SERVER_VERSION} from Maven Central...`);

download(ARTIFACT, JARS_DIR, MAVEN_CENTRAL_URL)
  .then((filename) => {
    fs.renameSync(filename, targetPath);
    console.log(`Camel LSP server downloaded to ${targetPath}`);
  })
  .catch((err) => {
    console.error('Failed to download Camel LSP server:', err.message || err);
    console.error(
      'LSP features will not be available. You can retry by running: yarn workspace vscode-kaoto postinstall',
    );
    process.exit(0);
  });
