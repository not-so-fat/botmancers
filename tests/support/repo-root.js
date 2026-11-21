'use strict';
// Canonical repository-root resolver for the root test suites.
//
// Every file in tests/ runs from the repository root, but its own directory
// is tests/ — so `__dirname` is NOT the repo root. Require this module
// instead of chaining `..` segments by hand:
//
//   const ROOT = require('./support/repo-root');
//
const path = require('path');

module.exports = path.resolve(__dirname, '..', '..');
