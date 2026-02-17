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
const {createHash} = require('node:crypto')

const fs = require('fs');
const {promises: fsp} = fs
const CppReference = require('../lib/extension.js');
const path = require('path');
const yaml = require("js-yaml");
const TAGFILE_REGISTRY_STORE_SYMBOL = Symbol.for('cppReferenceTagfileRegistryStore')

class RegistryConsumerStub {
    constructor(playbook) {
        this.playbook = playbook
        this.tagfiles = []
    }

    load() {
        const store = globalThis[TAGFILE_REGISTRY_STORE_SYMBOL]
        let registry =
            this.playbook?.runtime?.cppReferenceTagfileRegistry ||
            (store && (store.byObject.get(this.playbook) ||
                store.byObject.get(this.playbook.runtime) ||
                store.byDir.get(this.playbook.dir)))
        if (!registry) return
        this.tagfiles = registry.entries.map((entry) => ({
            file: entry.tagfilePath,
            module: entry.module,
            docRootUrl: entry.docRootUrl,
            relativePath: entry.relativePath,
            component: entry.component
        }))
    }
}

class generatorContext {
    constructor() {
        this.attributes = {}
    }

    on(eventName, handler) {
        ok(eventName === 'contentAggregated' || eventName === 'beforeProcess' || eventName === 'contentClassified')
        if (!this.handlers) {
            this.handlers = {}
        }
        if (!this.handlers[eventName]) {
            this.handlers[eventName] = []
        }
        this.handlers[eventName].push(handler)
    }

    once(eventName, Function) {
        ok(eventName === 'contentAggregated')
    }

    getLogger(name) {
        ok(name === 'cpp-reference-extension' || name === 'cpp-tagfile-extension')
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

// Ensures a registry survives repeated ensureTagfileRegistry calls.
test('ensureTagfileRegistry creates persistent registry snapshot', async () => {
    const logger = new generatorContext().getLogger('cpp-reference-extension')
    const playbook = {runtime: {}}
    const registry = CppReference.ensureTagfileRegistry(playbook, logger)
    ok(registry, 'Registry should be created')
    strictEqual(playbook.runtime.cppReferenceTagfileRegistry, registry)
    registry.registerProducer('reference')
    const waitPromise = registry.waitFor('reference')
    registry.finalize('reference')
    await waitPromise
    const reused = CppReference.ensureTagfileRegistry(playbook, logger)
    strictEqual(reused, registry, 'Existing registry should be reused')
})

// Ensures read-only runtime objects fall back to the global registry store.
test('ensureTagfileRegistry stores registry when runtime is not extensible', () => {
    const logger = new generatorContext().getLogger('cpp-reference-extension')
    const playbook = {}
    Object.defineProperty(playbook, 'runtime', {value: {}, writable: false, configurable: false})
    Object.preventExtensions(playbook.runtime)
    const registry = CppReference.ensureTagfileRegistry(playbook, logger)
    ok(registry, 'Registry should exist even when runtime is not extensible')
    const store = globalThis[TAGFILE_REGISTRY_STORE_SYMBOL]
    strictEqual(store.byObject.get(playbook), registry, 'Registry should be stored in the global WeakMap')
})

// Ensures frozen runtime objects also fall back to the global registry store.
test('ensureTagfileRegistry clones frozen runtime objects', () => {
    const logger = new generatorContext().getLogger('cpp-reference-extension')
    const playbook = {runtime: {}}
    Object.freeze(playbook.runtime)
    const registry = CppReference.ensureTagfileRegistry(playbook, logger)
    ok(registry, 'Registry should be created even when runtime is frozen')
    const store = globalThis[TAGFILE_REGISTRY_STORE_SYMBOL]
    strictEqual(store.byObject.get(playbook), registry, 'Frozen runtime should fall back to the global WeakMap')
})

// Ensures registry entries contain the expected metadata defaults.
test('recordTagfileMetadata publishes registry entry with defaults', () => {
    const context = new generatorContext()
    const playbook = {runtime: {}}
    const extension = new CppReference(context, {config: {}, playbook})
    const published = []
    extension.tagfileRegistry = {
        publish(entry) {
            published.push(entry)
        }
    }
    extension.MrDocsVersion = 'v1.2.3'
    extension.recordTagfileMetadata(
        {name: 'sample', version: '1.0.0'},
        'reference',
        {absolutePath: '/tmp/reference/reference.tag.xml', relativePath: 'reference/reference.tag.xml', checksum: 'abc', size: 42}
    )
    strictEqual(published.length, 1, 'Should publish a single entry')
    const entry = published[0]
    strictEqual(entry.component, 'sample')
    strictEqual(entry.module, 'reference')
    strictEqual(entry.docRootUrl, 'xref:reference:')
    strictEqual(entry.mrdocsVersion, 'v1.2.3')
    strictEqual(entry.tagfilePath, '/tmp/reference/reference.tag.xml')
})

// The integration test emulates an Antora run where the reference extension
// publishes a generated tagfile and a registry consumer reads it back.
test('reference and tagfiles extensions cooperate via registry', async () => {
    const fixtureDir = path.join(__dirname, 'fixtures', 'with-tagfiles')
    const playbookFile = path.join(fixtureDir, 'playbook.yml')
    const playbook = normalizePlaybook(yaml.load(fs.readFileSync(playbookFile, 'utf8')), fixtureDir)
    playbook.runtime.cacheDir = path.join(fixtureDir, '.cache')
    const componentDir = path.join(fixtureDir, 'component')
    const descriptor = yaml.load(fs.readFileSync(path.join(componentDir, 'antora.yml'), 'utf8'))
    const componentVersionBucket = {
        name: descriptor.name,
        version: descriptor.version,
        files: [],
        origins: [{
            descriptor,
            url: componentDir,
            gitdir: componentDir,
            refname: 'main',
            reftype: 'branch',
            remote: 'origin',
            startPath: '.',
            worktree: componentDir
        }]
    }
    const contentAggregate = [componentVersionBucket]
    const context = new generatorContext()
    const config = playbook.antora.extensions.find((extension) => extension.require === '@alandefreitas/antora-cpp-reference-extension')
    config.module = 'api-ref'
    const referenceExtension = new CppReference(context, {config, playbook})
    // Avoid cloning/downloading during tests; fixtures already contain the required files.
    referenceExtension.setupDependencies = async () => {}
    referenceExtension.setupMrDocs = async () => {
        referenceExtension.MrDocsExecutable = 'stub-mrdocs'
        referenceExtension.MrDocsVersion = '0.0.0-test'
    }
    const stubOutputDir = path.join(fixtureDir, 'reference-output')
    referenceExtension.runCommand = async (_cmd, argv) => {
        const outputArg = argv.find((arg) => arg.startsWith('--output='))
        ok(outputArg, 'MrDocs arguments should include --output')
        const outputDir = outputArg.slice('--output='.length)
        await fsp.rm(outputDir, {recursive: true, force: true})
        await fsp.mkdir(outputDir, {recursive: true})
        await fsp.cp(stubOutputDir, outputDir, {recursive: true})
    }
    await referenceExtension.onContentAggregated({playbook, siteAsciiDocConfig: {}, siteCatalog: {}, contentAggregate})
    const registry = playbook.runtime.cppReferenceTagfileRegistry
    ok(registry, 'Registry should exist after reference extension runs')
    const entry = registry.entries.find((it) => it.component === descriptor.name)
    ok(entry, 'Registry should include the demo component')
    strictEqual(entry.module, 'api-ref')
    strictEqual(entry.docRootUrl, 'xref:api-ref:')
    ok(fs.existsSync(entry.tagfilePath), 'Generated tagfile path should exist')

    // Run the tagfiles extension against the same playbook so it reads the registry entry.
    const consumer = new RegistryConsumerStub(playbook)
    consumer.load()
    const generatedTagfile = consumer.tagfiles.find((tf) => tf.file === entry.tagfilePath)
    ok(generatedTagfile, 'Registry consumer should import registry-provided tagfile')
    strictEqual(generatedTagfile.module, 'api-ref')
    strictEqual(generatedTagfile.docRootUrl, 'xref:api-ref:')
})

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
