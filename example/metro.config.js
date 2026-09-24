// The library is symlinked from the repo root. Hide the root's node_modules so
// it resolves react, react-native and expo from this app: one copy of each.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const libraryRoot = path.resolve(__dirname, '..')
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const config = getDefaultConfig(__dirname)
config.watchFolders = [libraryRoot]
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')]
config.resolver.blockList = [
  ...[config.resolver.blockList ?? []].flat(),
  new RegExp(`^${escape(path.join(libraryRoot, 'node_modules'))}/.*`),
]

module.exports = config
