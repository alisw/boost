/*
    Copyright (c) 2024 Alan de Freitas (alandefreitas@gmail.com)

    Distributed under the Boost Software License, Version 1.0. (See accompanying
    file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)

    Official repository: https://github.com/alandefreitas/antora-cpp-tagfiles-extension
*/


import test, {describe, it} from "node:test"
import {ok, strictEqual} from "node:assert"

import fs from 'fs'
import CppTagfilesExtension from '../lib/extension.js'
import {fileURLToPath} from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class generatorContext {
    constructor() {
        this.attributes = {}
    }

    on(eventName, Function) {
        ok(eventName === 'contentAggregated' || eventName === 'beforeProcess')
    }

    getLogger(name) {
        ok(name === 'cpp-tagfile-extension')
        const noop = () => {
        }
        return {
            trace: noop,
            debug: noop,
            info: noop,
            warn: noop,
            error: noop
        }
    }
}

/**
 * Parse input to extract the target and the attributes.
 *
 * The input has the following format:
 *
 * `cpp:<target>[<attributes strings>]`
 *
 * The target is the name of the C++ symbol.
 * The attributes are the attributes that will be used to generate the link.
 *
 * Example:
 *
 * `cpp:std::vector[]`
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
    const regex = /cpp:([a-z:_<>]+)\[(.*)]/
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


test('The extension produces links to C++ symbols', async (t) => {
    // ============================================================
    // Create extension object
    // ============================================================
    const antoraConfigPath = path.resolve(__dirname, 'antoraConfig.json')
    const antoraConfigFileContent = fs.readFileSync(antoraConfigPath, 'utf8')
    const {config, playbook, contentAggregate} = JSON.parse(antoraConfigFileContent)
    playbook.dir = __dirname
    for (let content of contentAggregate) {
        for (let origin of content.origins) {
            origin.worktree = path.resolve(__dirname, '..')
        }
    }
    const antoraContext = new generatorContext()
    const extension = new CppTagfilesExtension(antoraContext, {config, playbook})
    await extension.onContentAggregated({playbook, contentAggregate})

    // ============================================================
    // Load fixtures.json file with node.js built-in filesystem module
    // ============================================================
    const fixturesPath = path.resolve(__dirname, 'fixtures.json')
    const fileContent = fs.readFileSync(fixturesPath, 'utf8')
    const fixtures = JSON.parse(fileContent)

    await t.test('The extension object is created', () => {
        ok(extension)
    })

    await t.test('The extension object has a process method', () => {
        ok(extension.process)
    })

    await t.test('The fixtures file is loaded', () => {
        ok(fixtures)
    })

    // ============================================================
    // Iterate fixtures and run tests
    // ============================================================
    for (const {name, tests} of fixtures) {
        await t.test(name, async () => {
            for (const {input, output, component, attributes} of tests) {
                // Create a parent object with the component
                // parent?.document?.getAttributes()['page-component-name'] should return the component name
                const parent = component ? {
                    document: {
                        getAttributes: () => {
                            return {
                                'page-component-name': component
                            }
                        }
                    }
                } : {}
                const {target, attr} = parseInput(input)
                const result = extension.process(parent, target, attr)
                const error_message = `
                    Test failed for input: ${input} (component: ${component}). 
                    Expected: ${output}, 
                    but got: ${result}`;
                strictEqual(result, output, error_message)
            }
        })
    }

});