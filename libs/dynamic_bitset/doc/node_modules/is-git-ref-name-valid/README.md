# is-git-ref-name-valid

**Check that a git reference name is well formed, per [`git-check-ref-format(1)`](https://git-scm.com/docs/git-check-ref-format).**

[![npm status](http://img.shields.io/npm/v/is-git-ref-name-valid.svg)](https://www.npmjs.org/package/is-git-ref-name-valid)
[![node](https://img.shields.io/node/v/is-git-ref-name-valid.svg)](https://www.npmjs.org/package/is-git-ref-name-valid)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

## Usage

```js
const validRef = require('is-git-ref-name-valid')

validRef('refs/heads/foo.bar') // true
validRef('refs/heads/foo^bar') // false
```

Same as `git check-ref-format`, the reference name must contain a `/` by default. This can be disabled:

```js
validRef('ünicöde')       // false
validRef('ünicöde', true) // true
```

To validate branch names, for which there are additional rules, use [`is-git-branch-name-valid`](https://github.com/vweevers/is-git-branch-name-valid).

## API

### `validRef(name[, onelevel])`

Takes a string `name` and an optional `onelevel` boolean. Returns true if `name` is well formed. Throws if `name` is not a string. If `onelevel` is true then `name` does not have to contain a `/`.

## Install

With [npm](https://npmjs.org) do:

```
npm install is-git-ref-name-valid
```

## License

[MIT](LICENSE) © Vincent Weevers
