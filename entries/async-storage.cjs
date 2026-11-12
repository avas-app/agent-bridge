'use strict'

// Metro inlines NODE_ENV and drops the dead branch, so a release bundle
// never includes the bridge, the same way react/index.js works.
if (process.env.NODE_ENV === 'production') {
  module.exports = require('../dist/noop/async-storage.cjs')
} else {
  module.exports = require('../dist/adapters/async-storage.cjs')
}
