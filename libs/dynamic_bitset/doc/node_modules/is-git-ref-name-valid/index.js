'use strict'

// Last updated for git 2.29.0.
// eslint-disable-next-line no-control-regex
const bad = /(^|[/.])([/.]|$)|^@$|@{|[\x00-\x20\x7f~^:?*[\\]|\.lock(\/|$)/

module.exports = function validRef (name, onelevel) {
  if (typeof name !== 'string') {
    throw new TypeError('Reference name must be a string')
  }

  return !bad.test(name) && (!!onelevel || name.includes('/'))
}
