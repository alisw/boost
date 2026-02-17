/*
    Copyright (c) 2024 Alan de Freitas (alandefreitas@gmail.com)

    Distributed under the Boost Software License, Version 1.0. (See accompanying
    file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)

    Official repository: https://github.com/alandefreitas/antora-cpp-tagfiles-extension
*/

'use strict'

const test = require("node:test");
const {describe, it} = test;
const {ok, strictEqual} = require("node:assert");

const fs = require('fs');
const CppReference = require('../lib/extension.js');
const path = require('path');
const yaml = require("js-yaml");

class generatorContext {
    constructor() {
        this.attributes = {}
    }

    on(eventName, Function) {
        ok(eventName === 'contentAggregated')
    }

    once(eventName, Function) {
        ok(eventName === 'contentAggregated')
    }

    getLogger(name) {
        ok(name === 'cpp-reference-extension')
        const noop = () => {
        }
        return {trace: noop, debug: noop, info: noop, warn: noop, error: noop}
    }
}

describe('C++ Reference Extension', () => {
    const fixturesDir = path.join(__dirname, 'fixtures')

    // ============================================================
    // Iterate fixtures and run tests
    // ============================================================
    for (const fixture of fs.readdirSync(fixturesDir)) {
        const fixtureDir = path.join(fixturesDir, fixture)
        if (!fs.statSync(fixtureDir).isDirectory()) {
            continue
        }
        test(fixture, () => {
            const playbookFile = path.join(fixtureDir, 'playbook.yml')
            ok(fs.existsSync(playbookFile), `Fixture ${fixture} is missing playbook.yml`)
            ok(fs.statSync(playbookFile).isFile(), `Fixture ${fixture} has a non-file playbook.yml`)
            const playbookContents = fs.readFileSync(playbookFile, 'utf8')
            const playbook = normalizePlaybook(yaml.load(playbookContents), fixtureDir)
            ok(playbook, `Fixture ${fixture} has an invalid playbook.yml`)
            const config = playbook.antora.extensions.find(extension => extension.require === '@alandefreitas/antora-cpp-reference-extension')
            ok(config, `Fixture ${fixture} is missing the extension @alandefreitas/antora-cpp-reference-extension`)
            const context = new generatorContext();
            const extension = new CppReference(context, {config, playbook})
            ok(extension, `Fixture ${fixture} failed to create the extension`)
            const contentAggregate = {}
            // TODO: extension.onContentAggregated({playbook, siteAsciiDocConfig: {}, siteCatalog: {}, contentAggregate})
        })
    }
});

function normalizePlaybook(playbook, playbookDir) {
    if (!playbook) {
        return playbook
    }

    // Playbook carries its own directory
    playbook.dir = playbookDir

    // Branches
    if (!'content' in playbook) {
        playbook.content = {}
        if (!'branches' in playbook.content) {
            playbook.content.branches = [
                "HEAD",
                "v{0..9}*"
            ]
        }
    }

    // Extensions are objects
    if (!'antora' in playbook) {
        playbook.antora = {}
        if (!'extensions' in playbook.antora) {
            playbook.antora.extensions = []
        }
    }
    playbook.antora.extensions = playbook.antora.extensions.map(extension => {
        if (typeof extension === 'string') {
            return {require: extension}
        }
        return extension
    })


    // Extra fields
    playbook.network = {}
    playbook.runtime = {
        fetch: true,
        quiet: false,
        silent: false,
        log: {
            level: "all",
            levelFormat: "label",
            failureLevel: "fatal",
            format: "pretty"
        }
    }
    playbook.urls = {
        htmlExtensionStyle: "default",
        redirectFacility: "static"
    }
    playbook.output = {
        clean: false
    }

    return playbook
}