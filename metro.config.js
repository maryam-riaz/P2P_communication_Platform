const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const workspaceRoot = __dirname;
const projectRoot = path.resolve(workspaceRoot, 'packages/mobile');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo
config.watchFolders = [workspaceRoot];

// 2. Let Metro paths resolve from both directories
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Force Metro to resolve symlinks
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
