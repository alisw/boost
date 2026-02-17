/*
    Copyright (c) 2024 Alan de Freitas (alandefreitas@gmail.com)

    Distributed under the Boost Software License, Version 1.0. (See accompanying
    file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)

    Official repository: https://github.com/alandefreitas/antora-cpp-tagfiles-extension
*/


import test, {describe, it} from "node:test"
import {ok, strictEqual} from "node:assert"

import fs from 'fs'
import BoostLinksExtension from '../lib/extension.js'
import {fileURLToPath} from 'url';
import path from 'path';
import Asciidoctor from 'asciidoctor'
import assert from "assert";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse input to extract the target and the attributes.
 *
 * The input has the following format:
 *
 * `boost:<target>[<attributes strings>]`
 *
 * The target is the name of the Boost library.
 * The attributes are the attributes that will be used to generate the link.
 *
 * Example:
 *
 * `boost:core[]`
 *
 * Each attribute is separated by a comma. The attributes are either positional or named.
 * A positional attribute is a string that will be used to generate the link.
 * A named attribute is a key-value pair separated by an equal sign.
 *
 * Positional attributes are stored in the `$positional` key of the attributes object.
 * Named attributes are stored directly in the attributes object.
 *
 * @param input {string} The input string
 * @return {{target: string, attr: {}}}
 */
function parseInput(input) {
    const regex = /boost:([a-z]+)\[(.*)\]/
    const match = regex.exec(input)
    if (!match) {
        throw new Error(`Invalid input: ${input}`)
    }
    const target = match[1]
    const attributesStr = match[2]
    const attr = {}
    const positional = []
    if (attributesStr) {
        const attributeStrings = attributesStr.split(',')
        for (const attributeStr of attributeStrings) {
            const [key, value] = attributeStr.split('=')
            if (value) {
                attr[key] = value
            } else {
                positional.push(attributeStr)
            }
        }
    }
    if (positional.length !== 0) {
        attr.$positional = positional
    }
    return {target, attr}
}

describe('The extension produces links to Boost libraries', () => {
    // ============================================================
    // Load fixtures.json
    // ============================================================
    const fileContent = fs.readFileSync(path.join(__dirname, "fixtures.json"), 'utf8')
    const fixtures = JSON.parse(fileContent)

    // ============================================================
    // Iterate fixtures and run tests
    // ============================================================
    for (const {name, tests} of fixtures) {
        test(name, () => {
            for (const {input, output} of tests) {
                const {target, attr} = parseInput(input)
                const result = BoostLinksExtension.generateBoostLink(target, attr)
                const error_message = `Input: ${input}\nExpected Output: ${output}\nGot: ${result}`
                strictEqual(result, output, error_message)
            }
        })
    }
});

describe('The extension can be registered with Asciidoc', () => {
    const processor = Asciidoctor()
    processor.Extensions.register(BoostLinksExtension)
    const result = processor.convert(`boost:core[]`)
    // Check if result contains link to boost.core
    ok(result.includes('https://www.boost.org/libs/core'), 'The extension should produce a link to boost.core\nWe got the following result:\n' + result)
    ok(result.includes('Boost.Core'), 'The extension should produce a link to boost.core\nWe got the following result:\n' + result)
})
