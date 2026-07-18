const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo
config.watchFolders = [workspaceRoot];

// 2. Let Metro paths resolve from the workspace node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Force Metro to resolve symlinks
config.resolver.disableHierarchicalLookup = true;

// 4. Ensure unstable_serverRoot is projectRoot so that entry point paths relative to packages/mobile (../../node_modules/expo-router/entry.js) resolve correctly during native bundling
config.server = {
  ...config.server,
  unstable_serverRoot: projectRoot,
};

module.exports = config;
