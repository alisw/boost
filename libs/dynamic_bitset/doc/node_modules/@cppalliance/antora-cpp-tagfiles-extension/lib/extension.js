/*
    Copyright (c) 2024 Alan de Freitas (alandefreitas@gmail.com)

    Distributed under the Boost Software License, Version 1.0. (See accompanying
    file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)

    Official repository: https://github.com/alandefreitas/antora-cpp-tagfiles-extension
*/

'use strict'

const {createHash} = require('node:crypto')
const he = require("he");
const {XMLParser} = require("fast-xml-parser");
const expandPath = require('@antora/expand-path-helper')
const fs = require("fs");
const {promises: fsp} = fs
const git = require('isomorphic-git')
const path = require('path');
const assert = require("assert");
const ospath = require('node:path')
const getUserCacheDir = require('cache-directory')
const posixify = ospath.sep === '\\' ? (p) => p.replace(/\\/g, '/') : undefined

/**
 * CppTagfilesExtension is a class that handles the registration and processing of C++ tagfiles.
 * It is used to extend the functionality of the Antora documentation generator with the
 * inline macro `cpp:<symbol-name>[]` which transforms the symbol name into a link to the
 * cppreference.com documentation or the documentation in any doxygen tagfile.
 *
 * The extra tagfiles can be registered in
 * - the playbook file (antora.extensions.<cpp-tagfile-entry>,files) or
 * - the component descriptor file (ext.cpp-tagfiles.files)
 *
 * Each entry in `files` should contain the path to the tagfile and
 * the base URL for the documentation.
 *
 * The class registers itself to the generator context and listens to two events:
 * - 'contentAggregated': When this event is triggered, the class reads the tagfiles and parses them.
 * - 'beforeProcess': When this event is triggered, the class registers an AsciiDoc processor that processes 'cpp' inline macros.
 *
 * See https://docs.antora.org/antora/latest/extend/class-based-extension/
 *
 * The class also provides methods to get the URL for a symbol and to check if a given type is a fundamental type.
 *
 * @class
 * @property {Object} context - The generator context.
 * @property {Array} tagfiles - An array of tagfile objects.
 * @property {Object} logger - The logger object.
 * @property {Object} config - The configuration object.
 * @property {Object} playbook - The playbook object.
 *
 */
class CppTagfilesExtension {
    static register({config, playbook}) {
        new CppTagfilesExtension(this, {config, playbook})
    }

    constructor(generatorContext, {config, playbook}) {
        this.context = generatorContext
        const onContentAggregatedFn = this.onContentAggregated.bind(this)
        this.context.on('contentAggregated', onContentAggregatedFn)
        const onBeforeProcessFn = this.onBeforeProcess.bind(this)
        this.context.on('beforeProcess', onBeforeProcessFn)

        this.tagfiles = []
        this.usingNamespaces = []
        this.cache = {}

        // https://www.npmjs.com/package/@antora/logger
        // https://github.com/pinojs/pino/blob/main/docs/api.md
        this.logger = this.context.getLogger('cpp-tagfile-extension')
        this.logger.info('Registering cpp-tagfile-extension')

        this.config = config
        this.createWorktrees = config.createWorktrees || 'auto'
        // playbook = playbook
    }

    /**
     * Checks if a cached result exists for a given symbol and component.
     *
     * The cache is a map of maps. The first map is the symbol. The second level map is the component.
     * The value in the second map is the link.
     *
     * The reason we have two levels is that components might have different tagfiles. Thus,
     * the same target can have different links depending on the component.
     *
     * @param {string} symbol - The symbol for which the cached result is to be checked.
     * @param {string} component - The component for which the cached result is to be checked.
     * @returns {boolean} True if a cached result exists for the given symbol and component, false otherwise.
     */
    hasCachedResult(symbol, component) {
        return symbol in this.cache && component in this.cache[symbol]
    }

    /**
     * Retrieves a cached result for a given symbol and component.
     *
     * @param {string} symbol - The symbol for which the cached result is to be retrieved.
     * @param {string} component - The component for which the cached result is to be retrieved.
     * @returns {string} The cached result for the given symbol and component.
     */
    getCachedResult(symbol, component) {
        if (this.hasCachedResult(symbol, component)) {
            return this.cache[symbol][component]
        }
        return undefined
    }

    /**
     * Sets a cached result for a given symbol and component.
     *
     * If no cache exists for link given symbol, a new cache is created.
     *
     * @param {string} symbol - The symbol for which the cached result is to be set.
     * @param {string} component - The component for which the cached result is to be set.
     * @param {object} obj - The result to be cached.
     */
    setCachedResult(symbol, component, obj) {
        assert(typeof obj === 'object', 'obj should be an object')
        assert('href' in obj, 'obj should have href')
        assert('external' in obj, 'obj should have external')
        if (!(symbol in this.cache)) {
            this.cache[symbol] = {}
        }
        this.cache[symbol][component] = obj
    }

    // https://docs.antora.org/antora/latest/extend/add-event-listeners/
    // https://docs.antora.org/antora/latest/extend/generator-events-reference/

    /**
     * Event handler for the 'contentAggregated' event.
     * This event is triggered after all the content sources have been cloned and
     * the aggregate of all the content has been created.
     *
     * This method reads the tagfiles and parses them. The tagfiles are registered
     * in the playbook file or the component descriptor files.
     *
     * The method also removes duplicate tagfiles and logs the final list of tagfiles.
     *
     * @param {Object} playbook - The playbook object.
     * @param {Object} siteAsciiDocConfig - The AsciiDoc configuration for the site.
     * @param {Object} siteCatalog - The site catalog object.
     * @param {Array} contentAggregate - The aggregate of all the content.
     */
    async onContentAggregated({playbook, siteAsciiDocConfig, siteCatalog, contentAggregate}) {
        this.logger.info('Reading tagfiles')

        function normalizeBaseUrl(baseUrl) {
            baseUrl = baseUrl ? baseUrl : '';
            baseUrl = baseUrl.trim()
            const isHttp = baseUrl.startsWith('http://') || baseUrl.startsWith('https://');
            if (!baseUrl.endsWith('/') && isHttp) {
                return baseUrl + '/'
            }
            return baseUrl
        }

        function externalAsBoolean(tagfile) {
            const baseUrl = normalizeBaseUrl(tagfile.baseUrl);
            const baseUrlIsHttp = baseUrl.startsWith('http://') || baseUrl.startsWith('https://')
            const externalIsBoolean = typeof tagfile.external === 'boolean'
            const externalIsString = typeof tagfile.external === 'string'
            return externalIsBoolean ?
                tagfile.external :
                externalIsString ?
                    tagfile.external === 'true' :
                    baseUrlIsHttp
        }

        const {cacheDir, gitCache, managedWorktrees} = await this.initializeWorktreeManagement(playbook);

        // Iterate tagfiles set in the components
        for (const componentVersionBucket of contentAggregate.slice()) {
            this.logger.debug(CppTagfilesExtension.objectSummary(componentVersionBucket), 'componentVersionBucket')
            const {name, version, origins = []} = componentVersionBucket
            for (const origin of origins) {
                this.logger.debug(CppTagfilesExtension.objectSummary(origin), 'origin')
                const {url, gitdir, refname, reftype, remote, worktree, startPath, descriptor} = origin
                this.logger.debug(CppTagfilesExtension.objectSummary(descriptor), 'descriptor')
                this.logger.debug(`worktree: ${worktree}`)

                // Get config objects
                let tagfileConfigs = descriptor?.ext?.cppTagfiles || []
                if (!Array.isArray(tagfileConfigs)) {
                    tagfileConfigs = [tagfileConfigs]
                }
                if (!tagfileConfigs.length) {
                    this.logger.info(`No tagfiles configuration found for component ${name} version ${version}`)
                    continue
                }
                this.logger.debug(CppTagfilesExtension.objectSummary(tagfileConfigs), 'tagfileConfigs')

                // Get worktree directory
                let worktreeDir = worktree
                let worktreeConfig = tagfileConfigs[0].worktree || {}
                if (!worktreeConfig) {
                    worktreeConfig = worktreeConfig === false ? {create: 'always'} : {}
                }
                this.logger.debug(CppTagfilesExtension.objectSummary(worktreeConfig), 'worktreeConfig')
                const createWorktree =
                    !worktree || ('create' in worktreeConfig ? worktreeConfig.create : this.createWorktrees) === 'always'
                const checkoutWorktree = worktreeConfig.checkout !== false
                this.logger.debug(`Create worktree: ${createWorktree}`)
                this.logger.debug(`Checkout worktree: ${checkoutWorktree}`)
                if (createWorktree) {
                    this.logger.debug(`Worktree directory not provided for ${name} version ${version}`)
                    worktreeDir = await this.setupManagedWorktree(worktreeConfig, checkoutWorktree, origin, cacheDir, managedWorktrees);
                    this.logger.debug(`Worktree directory: ${worktreeDir}`)
                }

                // If the worktree doesn't exist, either checkout the worktree or create the directory
                if (createWorktree) {
                    if (checkoutWorktree) {
                        this.logger.debug(`Checking out worktree: ${worktreeDir}`)
                        const cache = gitCache[gitdir] || (gitCache[gitdir] = {})
                        const ref = `refs/${reftype === 'branch' ? 'head' : reftype}s/${refname}`
                        this.logger.debug(cache, 'Cache')
                        this.logger.debug(`Ref: ${ref}.`)
                        await this.prepareWorktree({
                            fs,
                            cache,
                            dir: worktreeDir,
                            gitdir,
                            ref,
                            remote,
                            bare: worktree === undefined
                        })
                        this.logger.debug(`Checked out worktree: ${worktreeDir}`)
                    } else {
                        this.logger.debug(`Creating worktree directory: ${worktreeDir}`)
                        await fsp.mkdir(worktreeDir, {recursive: true})
                    }
                } else {
                    this.logger.debug(`Using existing worktree directory: ${worktreeDir}`)
                }

                let tagFilesConfig = descriptor?.ext?.cppTagfiles?.files || []
                this.logger.debug(CppTagfilesExtension.objectSummary(tagFilesConfig), 'tagFilesConfig')
                for (const tagfile of tagFilesConfig) {
                    this.tagfiles.push({
                        file: path.join(worktreeDir, tagfile.file),
                        baseUrl: normalizeBaseUrl(tagfile.baseUrl),
                        component: descriptor.name,
                        external: externalAsBoolean(tagfile)
                    })
                }
            }
        }
        this.logger.info(this.tagfiles, 'tagfiles')

        // Iterate tagfiles in the playbook
        const playbookFiles = this.config?.cppTagfiles?.files || []
        playbookFiles.forEach(tagfile => {
            this.tagfiles.push({
                file: path.join(playbook.dir, tagfile.file),
                baseUrl: normalizeBaseUrl(tagfile.baseUrl),
                component: null,
                external: externalAsBoolean(tagfile)
            })
        })

        // Add the cppreference tagfile
        //
        // To generate the most recent cppreference tags, you can get them from
        // https://en.cppreference.com/w/Cppreference:Archives or generate a
        // more recent version using the following commands:
        //
        // ```
        // git clone https://github.com/PeterFeicht/cppreference-doc
        // cd cppreference-doc
        // make source
        // make doc_doxygen
        // ```
        //
        // The result will be in ./output.
        const defaultTagfilesDir = path.join(__dirname, 'cpp_tagfiles');
        this.tagfiles.push({
            file: path.join(defaultTagfilesDir, 'cppreference-doxygen-web.tag.xml'),
            baseUrl: 'https://en.cppreference.com/w/',
            component: null,
            external: true
        })

        // Remove duplicates considering both the file and the component
        this.tagfiles = this.tagfiles.filter((tagfile, index, self) =>
            index === self.findIndex((t) => (
                t.file === tagfile.file && t.component === tagfile.component
            )))
        this.logger.info(this.tagfiles, 'tagfiles')

        // Read the tagfiles
        const parser = new XMLParser({
            ignoreDeclaration: true,
            ignoreAttributes: false,
            attributesGroupName: "@attributes",
            attributeNamePrefix: "",
            allowBooleanAttributes: true
        });
        for (let tagfile of this.tagfiles) {
            const {file} = tagfile
            this.logger.debug(`Reading tagfile: ${file}`)
            if (!fs.existsSync(file)) {
                this.logger.error(`Tagfile not found: ${file}`)
                continue
            }
            this.logger.debug(`Parsing tagfile: ${file}`)
            const xml = fs.readFileSync(file, 'utf8');
            tagfile.doc = parser.parse(xml);
        }

        // Iterate using-namespace set in the components
        for (const componentVersionBucket of contentAggregate.slice()) {
            const {origins = []} = componentVersionBucket
            for (const origin of origins) {
                const {descriptor, worktree} = origin
                let usingNamespacesConfig = descriptor?.ext?.cppTagfiles?.usingNamespaces || []
                for (const namespace of usingNamespacesConfig) {
                    this.usingNamespaces.push({
                        namespace: namespace.endsWith('::') ? namespace : namespace + '::',
                        component: descriptor.name
                    })
                }
            }
        }

        // Iterate tagfiles in the playbook
        const playbookNamespaces = this.config?.cppTagfiles?.usingNamespaces || []
        playbookNamespaces.forEach(namespace => {
            this.usingNamespaces.push({
                namespace: namespace.endsWith('::') ? namespace : namespace + '::',
                component: null
            })
        })

        // Add the default using namespace
        this.usingNamespaces.push({
            namespace: 'std::',
            component: null
        })

        // Remove duplicates considering both the file and the component
        this.usingNamespaces = this.usingNamespaces.filter((tagfile, index, self) =>
            index === self.findIndex((t) => (
                t.namespace === tagfile.namespace && t.component === tagfile.component
            )))

        await this.performWorktreeRemovals(managedWorktrees)
    }

    /**
     * Initializes the worktree management
     *
     * A worktree in Git is a separate working copy of the same repository
     * allowing you to work on two different branches at the same time.
     *
     * This method is used to initialize the worktree management by determining
     * the cache directory and creating it if it doesn't exist,
     * initializing a cache for git repositories, and initializing
     * a map to manage worktrees.
     *
     * It takes one argument: `playbook`. `playbook` is the playbook object.
     *
     * The method returns a promise that resolves with an object
     * containing `cacheDir`, `gitCache`, and `managedWorktrees`.
     * `cacheDir` is the determined cache directory. `gitCache`
     * is the initialized cache for git repositories. `managedWorktrees`
     * is the initialized map to manage worktrees.
     *
     * @param {Object} playbook - The playbook object.
     * @returns {Promise<Object>} A promise that resolves with an
     * object containing `cacheDir`, `gitCache`, and `managedWorktrees`.
     */
    async initializeWorktreeManagement(playbook) {
        // Determine the cache directory and create it if it doesn't exist
        const baseCacheDir = CppTagfilesExtension.getBaseCacheDir(playbook)
        const cacheDir = ospath.join(baseCacheDir, 'cpp-tagfiles-extension')
        await fsp.mkdir(cacheDir, {recursive: true})
        this.logger.debug(`Cache directory: ${cacheDir}`)

        // Initialize a cache for git repositories
        const gitCache = {}
        // Initialize a map to manage worktrees
        const managedWorktrees = new Map()
        return {cacheDir, gitCache, managedWorktrees};
    }

    /**
     * Prepares a worktree directory for a given origin.
     *
     * A worktree in Git is a separate working copy of the same repository
     * allowing you to work on two different branches at the same time.
     *
     * This method is used to prepare a worktree directory for a given origin.
     * It determines whether to check out the worktree and whether to keep the
     * worktree after use.
     *
     * It generates a name for the worktree directory and checks if the
     * worktree directory is already being managed.
     *
     * - If the worktree directory is already being managed, it adds the origin to it.
     * - If the worktree directory is not being managed, it adds it to the managed worktrees map.
     * - If the worktree is not being checked out or it's not being kept, it removes the directory.
     *
     * @param {Object} worktreeConfig - The worktree configuration object.
     * @param {boolean} checkoutWorktree - Whether to checkout the worktree.
     * @param {Object} origin - The origin object.
     * @param {string} cacheDir - The cache directory.
     * @param {Map} managedWorktrees - The map to manage worktrees.
     * @returns {Promise<string>} A promise that resolves with the worktree directory.
     */
    async setupManagedWorktree(worktreeConfig, checkoutWorktree, origin, cacheDir, managedWorktrees) {
        // Determine whether we should keep the worktree after use.
        // By default, we don't keep it unless explicitly set to true.
        const keepWorktree =
            'keep' in worktreeConfig ?
                worktreeConfig.keep :
                'keepWorktrees' in this.config ?
                    this.config.keepWorktrees === true :
                    false
        this.logger.debug(`Creating worktree for ${origin.url} with keepWorktree=${keepWorktree}`)

        // Generate a name for the worktree directory and join it with
        // the cache directory path.
        const worktreeFolderName = CppTagfilesExtension.generateWorktreeFolderName(origin, keepWorktree);
        let worktreeDir = ospath.join(cacheDir, worktreeFolderName)
        this.logger.debug(`Worktree directory: ${worktreeDir}`)

        // Check if the worktree directory is already being managed.
        // If it is, we add the origin to it.
        // Otherwise, we create a new entry in the managed worktrees map.
        if (managedWorktrees.has(worktreeDir)) {
            this.logger.debug(`Worktree directory ${worktreeDir} is already being managed`)
            managedWorktrees.get(worktreeDir).origins.add(origin)
            // If we're not checking out the worktree, we remove the directory.
            if (!checkoutWorktree) {
                this.logger.debug(`Removing worktree directory ${worktreeDir} as we're not checking it out`)
                await fsp.rm(worktreeDir, {force: true, recursive: true})
            }
        } else {
            this.logger.debug(`Worktree directory ${worktreeDir} is not being managed`)
            // If the worktree directory is not being managed, we add it to the managed worktrees map.
            managedWorktrees.set(worktreeDir, {origins: new Set([origin]), keep: keepWorktree})
            // If we're not checking out the worktree, or we're not keeping it, we remove the directory.
            if (!checkoutWorktree || keepWorktree !== true) {
                this.logger.debug(`Removing worktree directory ${worktreeDir} as we're not checking it out or keeping it`)
                await fsp.rm(worktreeDir, {
                    force: true,
                    recursive: true
                })
            }
        }
        return worktreeDir;
    }

    /**
     * Generates a unique folder name for a worktree.
     *
     * A worktree in Git is a separate working copy of the same repository
     * allowing you to work on two different branches at the same time.
     *
     * This method generates a unique folder name for a worktree based on the
     * repository URL, the directory of the Git repository, the reference name
     * (branch name), and the worktree directory.
     *
     * @param {Object} options - An object containing `url`, `gitdir`, `refname`, and `worktree` properties.
     * @param {string} options.url - The URL of the Git repository.
     * @param {string} options.gitdir - The directory of the Git repository.
     * @param {string} options.refname - The reference name (branch name).
     * @param {string} options.worktree - The worktree directory.
     * @param {boolean} keepWorktrees - Flag indicating whether to keep worktrees.
     * @returns {string} The generated folder name for the worktree.
     */
    static generateWorktreeFolderName({url, gitdir, refname, worktree}, keepWorktrees) {
        // Create a qualifier for the reference name if worktrees are to be kept
        const refnameQualifier = keepWorktrees ? '@' + refname.replace(/[/]/g, '-') : undefined
        // If worktree is undefined, generate a folder name based on the gitdir
        if (worktree === undefined) {
            const folderName = ospath.basename(gitdir, '.git')
            if (!refnameQualifier) return folderName
            const lastHyphenIdx = folderName.lastIndexOf('-')
            return `${folderName.slice(0, lastHyphenIdx)}${refnameQualifier}${folderName.slice(lastHyphenIdx)}`
        }
        // Normalize the URL or gitdir
        let normalizedUrl = (url || gitdir).toLowerCase()
        if (posixify) normalizedUrl = posixify(normalizedUrl)
        normalizedUrl = normalizedUrl.replace(/(?:[/]?\.git|[/])$/, '')
        // Create a slug based on the normalized URL and the refname qualifier
        const slug = ospath.basename(normalizedUrl) + (refnameQualifier || '')
        // Create a hash of the normalized URL
        const hash = createHash('sha1').update(normalizedUrl).digest('hex')
        // Return the slug and hash as the folder name
        return `${slug}-${hash}`
    }

    /**
     * Prepares a git worktree from the specified gitdir, making use of the existing clone.
     *
     * If the worktree already exists from a previous iteration, the worktree is reset.
     *
     * A valid worktree is one that contains a .git/index file.
     * Otherwise, a fresh worktree is created.
     *
     * If the gitdir contains an index file, that index file is temporarily overwritten to
     * prepare the worktree and later restored before the function returns.
     *
     * @param {Object} repo - The repository object.
     */
    async prepareWorktree(repo) {
        const {dir: worktreeDir, gitdir, ref, remote = 'origin', bare, cache} = repo
        this.logger.debug(`Preparing worktree for ${worktreeDir} from ${gitdir} at ${ref}`)
        delete repo.remote
        const currentIndexPath = ospath.join(gitdir, 'index')
        this.logger.debug(`Current index: ${currentIndexPath}`)
        const currentIndexPathBak = currentIndexPath + '~'
        this.logger.debug(`Current index backup: ${currentIndexPathBak}`)
        const restoreIndex = (await fsp.rename(currentIndexPath, currentIndexPathBak).catch(() => false)) === undefined
        this.logger.debug(`Restore index: ${restoreIndex} because it was not possible to rename ${currentIndexPath} to ${currentIndexPathBak}`)
        const worktreeGitdir = ospath.join(worktreeDir, '.git')
        this.logger.debug(`Worktree gitdir: ${worktreeGitdir}`)
        const worktreeIndexPath = ospath.join(worktreeGitdir, 'index')
        this.logger.debug(`Worktree index: ${worktreeIndexPath}`)
        try {
            let force = true
            try {
                await CppTagfilesExtension.mv(worktreeIndexPath, currentIndexPath)
                this.logger.debug(`Moved ${worktreeIndexPath} to ${currentIndexPath}`)
                await CppTagfilesExtension.removeUntrackedFiles(repo)
                this.logger.debug(`Removed untracked files from ${worktreeDir}`)
            } catch {
                this.logger.debug(`Could not move ${worktreeIndexPath} to ${currentIndexPath}`)
                force = false
                // index file not needed in this case
                await fsp.unlink(currentIndexPath).catch(() => undefined)
                await fsp.rm(worktreeDir, {recursive: true, force: true})
                await fsp.mkdir(worktreeGitdir, {recursive: true})
                this.logger.debug(`Created worktree directory ${worktreeDir}`)
                Reflect.ownKeys(cache).forEach((it) => it.toString() === 'Symbol(PackfileCache)' || delete cache[it])
                this.logger.debug(`Removed cache for ${worktreeDir}`)
            }
            let head
            if (ref.startsWith('refs/heads/')) {
                head = `ref: ${ref}`
                const branchName = ref.slice(11)
                if (bare || !(await git.listBranches(repo)).includes(branchName)) {
                    await git.branch({
                        ...repo,
                        ref: branchName,
                        object: `refs/remotes/${remote}/${branchName}`,
                        force: true
                    })
                }
            } else {
                head = await git.resolveRef(repo)
            }
            this.logger.debug(`Checking out HEAD: ${head}`)
            await git.checkout({...repo, force, noUpdateHead: true, track: false})
            this.logger.debug(`Checked out HEAD: ${head} at ${worktreeDir}`)
            await fsp.writeFile(ospath.join(worktreeGitdir, 'commondir'), `${gitdir}\n`, 'utf8')
            this.logger.debug(`Wrote commondir: ${gitdir}`)
            const headPath = ospath.join(worktreeGitdir, 'HEAD');
            await fsp.writeFile(headPath, `${head}\n`, 'utf8')
            this.logger.debug(`Wrote HEAD path: ${headPath}`)
            await CppTagfilesExtension.mv(currentIndexPath, worktreeIndexPath)
            this.logger.debug(`Moved ${currentIndexPath} to ${worktreeIndexPath}`)
        } finally {
            if (restoreIndex) await fsp.rename(currentIndexPathBak, currentIndexPath)
        }
    }

    static mv(from, to) {
        return fsp.cp(from, to).then(() => fsp.rm(from))
    }

    static removeUntrackedFiles(repo) {
        const trees = [git.STAGE({}), git.WORKDIR()]
        const map = (relpath, [sEntry]) => {
            if (relpath === '.') return
            if (relpath === '.git') return null
            if (sEntry == null) return fsp.rm(ospath.join(repo.dir, relpath), {recursive: true}).then(invariably.null)
            return sEntry.mode().then((mode) => (mode === 0o120000 ? null : undefined))
        }
        return git.walk({...repo, trees, map})
    }



    /**
     * Determines the base directory for caching.
     *
     * This static method of the `CppTagfilesExtension` class is used to determine the base directory for caching.
     * It takes an object as an argument, which has two properties: `dir` and `runtime`. `dir` is aliased as `dot`,
     * and `runtime` is an object that contains a `cacheDir` property.
     *
     * If `cacheDir` is `null`, the function tries to get the user cache directory by calling the `getUserCacheDir`
     * function with a string argument. This string argument is either 'antora' or 'antora-test', depending on whether
     * the `NODE_ENV` environment variable is set to 'test'. If `getUserCacheDir` returns a falsy value, it falls back
     * to a default directory path, which is the `.cache/antora` directory inside the `dir` directory.
     *
     * If `cacheDir` is not `null`, the function calls `expandPath` with `cacheDir` and an object containing `dir` as arguments.
     *
     * @param {Object} options - An object containing `dir` and `runtime` properties.
     * @param {string} options.dir - The directory to use as a base for caching.
     * @param {Object} options.runtime - An object containing a `cacheDir` property.
     * @param {string} options.runtime.cacheDir - The preferred cache directory.
     * @returns {string} The determined cache directory.
     */
    static getBaseCacheDir({dir: dot, runtime: {cacheDir: preferredDir}}) {
        return preferredDir == null
            ? getUserCacheDir(`antora${process.env.NODE_ENV === 'test' ? '-test' : ''}`) || ospath.join(dot, '.cache/antora')
            : expandPath(preferredDir, {dot})
    }

    /**
     * Performs the removal of worktrees.
     *
     * A worktree in Git is a separate working copy of the same repository
     * allowing you to work on two different branches at the same time.
     *
     * This method is used to perform the removal of worktrees.
     * It prepares for deferred worktree removals
     * and then performs the deferred worktree removals.
     *
     * @param {Map} managedWorktrees - The map of worktrees that are being managed.
     */
    async performWorktreeRemovals(managedWorktrees) {
        const deferredWorktreeRemovals = await this.prepareDeferredWorktreeRemovals(managedWorktrees);
        await this.performDeferredWorktreeRemovals(deferredWorktreeRemovals);
    }

        /**
     * Prepares for the deferred removal of worktrees.
     *
     * A worktree in Git is a separate working copy of the same repository
     * allowing you to work on two different branches at the same time.
     *
     * This method is used to prepare for the deferred removal of worktrees.
     * It iterates over the managed worktrees and checks the 'keep' property of each worktree.
     * If 'keep' is true, the worktree is skipped.
     * If 'keep' is a string that starts with 'until:', the worktree removal is deferred until the specified event.
     * Otherwise, the worktree is removed immediately.
     *
     * The method returns a promise that resolves with a map of deferred worktree removals.
     * Each entry in the map is an array of worktrees to be removed when a specific event occurs.
     *
     * @param {Map} managedWorktrees - The map of worktrees that are being managed.
     * @returns {Promise<Map>} A promise that resolves with a map of deferred worktree removals.
     */
    async prepareDeferredWorktreeRemovals(managedWorktrees) {
        // Prepare for deferred worktree removals
        this.logger.debug('Preparing for manual worktree removals')
        const deferredWorktreeRemovals = new Map()
        for (const [worktreeDir, {origins, keep}] of managedWorktrees) {
            this.logger.debug(`Managing worktree directory: ${worktreeDir}`)
            if (keep === true) continue
            if (typeof keep === 'string' && keep.startsWith('until:')) {
                const eventName = keep === 'until:exit' ? 'contextClosed' : keep.slice(6)
                const removal = {worktreeDir, origins}
                const removals = deferredWorktreeRemovals.get(eventName)
                removals ? removals.push(removal) : deferredWorktreeRemovals.set(eventName, [removal])
                continue
            }
            await CppTagfilesExtension.removeWorktree(worktreeDir, origins)
        }
        return deferredWorktreeRemovals
    }

    /**
     * Performs the deferred removal of worktrees.
     *
     * A worktree in Git is a separate working copy of the same repository
     * allowing you to work on two different branches at the same time.
     *
     * This method is used to perform the deferred removal of worktrees.
     * It iterates over the deferred worktree removals and for each removal,
     * it sets up an event listener that triggers the removal of the worktree
     * when the specified event occurs.
     *
     * It takes one argument: `deferredWorktreeRemovals`. `deferredWorktreeRemovals` is a map
     * where each entry is an array of worktrees to be removed when a specific event occurs.
     *
     * The method does not return a value.
     *
     * @param {Map} deferredWorktreeRemovals - A map of deferred worktree removals.
     */
    async performDeferredWorktreeRemovals(deferredWorktreeRemovals) {
        // Perform deferred worktree removals
        for (const [eventName, removals] of deferredWorktreeRemovals) {
            this.context.once(eventName, () =>
                Promise.all(
                    removals.map(({worktreeDir, origins}) =>
                        CppTagfilesExtension.removeWorktree(worktreeDir, origins)))
            )
        }
    }

    /**
     * Asynchronously removes a worktree directory and deletes the 'collectorWorktree' property from each origin.
     *
     * A worktree in Git is a separate working copy of the same repository
     * allowing you to work on two different branches at the same time.
     *
     * This static method of the `CppTagfilesExtension` class is used to remove a worktree
     * directory and delete the 'collectorWorktree' property from each origin.
     *
     * It takes two arguments: `worktreeDir` and `origins`. `worktreeDir` is the directory
     * of the worktree to be removed. `origins` is an array of origin objects.
     *
     * The method returns a promise that resolves when the worktree directory has been
     * removed and the 'collectorWorktree' property has been deleted from each origin.
     *
     * @param {string} worktreeDir - The directory of the worktree to be removed.
     * @param {Array} origins - An array of origin objects.
     * @returns {Promise} A promise that resolves when the worktree directory has been removed and the 'collectorWorktree' property has been deleted from each origin.
     */
    static async removeWorktree(worktreeDir, origins) {
        // Iterate over each origin
        for (const origin of origins) {
            // Delete the 'collectorWorktree' property from the origin
            delete origin.collectorWorktree
        }
        // Remove the worktree directory
        await fsp.rm(worktreeDir, {recursive: true})
    }

    /**
     * Event handler for the 'beforeProcess' event.
     * This event is triggered before the content is processed.
     *
     * This method registers an AsciiDoc processor that processes 'cpp' inline macros.
     * The processor transforms the symbol name into a link to the cppreference.com
     * documentation or the documentation in any doxygen tagfile.
     *
     * @param {Object} playbook - The playbook object.
     * @param {Object} siteAsciiDocConfig - The AsciiDoc configuration for the site.
     * @param {Object} siteCatalog - The site catalog object.
     */
    onBeforeProcess({playbook, siteAsciiDocConfig, siteCatalog}) {
        this.logger.info('Registering the tagfiles asciidoc processor')
        if (!siteAsciiDocConfig.extensions) siteAsciiDocConfig.extensions = []
        const extensionSelf = this
        siteAsciiDocConfig.extensions.push({
            register: (registry, _context) => {
                registry.inlineMacro('cpp', function () {
                    const self = this;
                    self.process(function (parent, target, attr) {
                        return self.createInline(
                            parent,
                            'quoted',
                            extensionSelf.process(parent, target, attr),
                            {type: 'monospaced'})
                    })
                })
                return registry
            }
        })
    }

    /**
     * This method processes the input symbol and generates a link to the documentation for that symbol.
     *
     * @param {Object} parent - The parent object in the AsciiDoc content model tree.
     * @param {string} target - The symbol to be processed.
     * @param {Object} attr - The attributes associated with the symbol.
     * @returns {string} The processed symbol, which is a link to the documentation for the symbol.
     */
    process(parent, target, attr) {
        const linkText = '$positional' in attr ? attr['$positional'][0] : undefined
        const component = parent?.document?.getAttributes()['page-component-name'] || null
        const decodedSymbol = he.decode(target);
        let link = this.getSymbolLink(decodedSymbol, linkText, component, '')
        if (link) {
            return link
        }
        return linkText ? linkText : target
    }

    /**
     * Gets the URL for a symbol.
     *
     * @param symbol - The name of the symbol.
     * @param component - The Antora component the symbol belongs to.
     * @param namespace - The namespace where we will look for the symbol
     * @returns {undefined|string} The URL for the symbol, or undefined if the symbol is not found.
     */
    getSymbolLink(symbol, linkText, component, namespace) {
        if (CppTagfilesExtension.isFundamentalType(symbol)) {
            return `https://en.cppreference.com/w/cpp/language/types${CppTagfilesExtension.getFundamentalTypeAnchor(symbol)}[${symbol},window=_blank]`
        }

        // Handle links to include files
        const isIncludeFile = symbol.startsWith('"') && symbol.endsWith('"') ||
            symbol.startsWith('<') && symbol.endsWith('>');
        if (isIncludeFile) {
            if (this.hasCachedResult(symbol, component)) {
                const {href, external} = this.getCachedResult(symbol, component)
                const attr = [linkText ? linkText : he.encode(symbol)].concat(external ? ['window="_blank"'] : [])
                return `${href}[${attr.join(',')}]`
            }
            for (const tagfile of this.tagfiles) {
                if (tagfile.component !== null && tagfile.component !== component) {
                    continue
                }
                const filename = CppTagfilesExtension.getFileFilename(tagfile.doc, symbol)
                if (filename) {
                    const href = `${tagfile.baseUrl}${filename}`
                    const attr = [linkText ? linkText : he.encode(symbol)].concat(tagfile.external ? ['window="_blank"'] : [])
                    this.setCachedResult(symbol, component, {href: href, external: tagfile.external})
                    return `${href}[${attr.join(',')}]`
                }
            }
            this.setCachedResult(symbol, component, {
                href: undefined,
                external: false
            })
            return undefined
        }

        // Handle symbols
        const isTemplate = symbol.includes('<');
        if (!isTemplate) {
            if (this.hasCachedResult(symbol, component)) {
                const {href, external} = this.getCachedResult(symbol, component)
                const attr = [linkText ? linkText : he.encode(symbol)].concat(external ? ['window="_blank"'] : [])
                return `${href}[${attr.join(',')}]`
            }

            // Handle symbols that are not templates
            for (const tagfile of this.tagfiles) {
                if (tagfile.component !== null && tagfile.component !== component) {
                    continue
                }
                const qualifiedSymbol = namespace + symbol
                this.logger.trace(`Looking for ${symbol} in namespace ${namespace} in ${tagfile.file}`)
                const filename = CppTagfilesExtension.getSymbolFilename(tagfile.doc['tagfile'], qualifiedSymbol, '')
                if (filename !== undefined) {
                    const href = `${tagfile.baseUrl}${filename}`
                    const attr = [linkText ? linkText : he.encode(symbol)].concat(tagfile.external ? ['window="_blank"'] : [])
                    this.setCachedResult(symbol, component, {href: href, external: tagfile.external})
                    return `${href}[${attr.join(',')}]`
                }
            }

            const lookInNamespaces = namespace === ''
            if (lookInNamespaces) {
                for (const usingNamespace of this.usingNamespaces) {
                    if (usingNamespace.component !== null && usingNamespace.component !== component) {
                        continue
                    }
                    assert(usingNamespace.namespace.endsWith('::'), 'Namespace should end with ::')
                    const result = this.getSymbolLink(symbol, linkText, component, usingNamespace.namespace)
                    if (result !== undefined) {
                        return result
                    }
                }
            }
        } else {
            // Handle symbols that are templates (we don't need the cache for templates)
            const {mainSymbolName, templateParameters, rest} = CppTagfilesExtension.splitCppSymbol(symbol)
            let fullLink
            const mainLink = this.getSymbolLink(mainSymbolName, linkText, component, namespace)
            if (mainLink) {
                fullLink = mainLink
            } else {
                fullLink = he.encode(mainSymbolName)
            }
            if (linkText) {
                // If the link text is provided, we return a single link to the main symbol
                return fullLink
            }
            fullLink += he.encode('<')
            let isFirst = true
            for (const templateParameter of templateParameters) {
                const templateParameterLink = this.getSymbolLink(templateParameter, linkText, component, namespace)
                if (!isFirst) {
                    fullLink += he.encode(', ')
                }
                if (templateParameterLink) {
                    fullLink += templateParameterLink
                } else {
                    fullLink += he.encode(templateParameter)
                }
                isFirst = false
            }
            fullLink += he.encode('>')
            if (rest.startsWith('::')) {
                fullLink += he.encode('::')
                const restLink = this.getSymbolLink(mainSymbolName + rest, linkText, component, namespace)
                if (restLink) {
                    fullLink += restLink
                } else {
                    fullLink += he.encode(rest.substring(2))
                }
            } else {
                fullLink += he.encode(rest)
            }
            return fullLink
        }
        return undefined
    }

    /**
     * Returns the anchor for a given fundamental type symbol.
     *
     * This function checks if the provided symbol is a fundamental type. If it is, the function returns the anchor for the type.
     * The anchors are used to link to the cppreference.com documentation for the type.
     *
     * @see https://en.cppreference.com/w/cpp/language/types
     *
     * @param {string} symbol - The fundamental type symbol.
     * @returns {string} The anchor for the fundamental type symbol, or an empty string if the symbol is not a fundamental type.
     */
    static getFundamentalTypeAnchor(symbol) {
        const anchors = {
            'bool': '#Boolean_type',
            'char': '#Character_types',
            'char8_t': '#Character_types',
            'char16_t': '#Character_types',
            'char32_t': '#Character_types',
            'wchar_t': '#Character_types',
            'int': '#Standard_integer_types',
            'signed': '#Standard_integer_types',
            'unsigned': '#Standard_integer_types',
            'short': '#Standard_integer_types',
            'long': '#Standard_integer_types',
            'float': '#Floating-point_types',
            'true': '#Boolean_type',
            'false': '#Boolean_type',
            'double': '#Floating-point_types',
            'long double': '#Floating-point_types',
            'void': '#void',
        }
        if (symbol in anchors) {
            return anchors[symbol]
        }
        return ''
    }

    /**
     * Returns true if the given type is a fundamental type.
     * This is used to link to the cppreference.com documentation for the type.
     *
     * @see https://en.cppreference.com/w/cpp/language/types
     *
     * @param type - The type to check.
     * @returns {boolean} True if the type is a fundamental type.
     */
    static isFundamentalType(type) {
        return ['bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'wchar_t', 'int', 'signed', 'unsigned', 'short', 'long', 'float', 'true', 'false', 'double', 'long double', 'void'].includes(type)
    }

    /**
     * Retrieves the filename URL of a given file from the provided documentation object.
     *
     * For instance, it returns 'cpp/header/algorithm' for the symbol 'algorithm',
     * which is the filename URL for the cppreference.com documentation.
     *
     * This function iterates over the 'compound' elements in the documentation object,
     * looking for a match with the provided symbol. If a match is found, the filename
     * associated with that compound is returned.
     *
     * @param {Object} doc - The documentation object parsed from a tagfile.
     * @param {string} symbol - The symbol for which the filename is to be retrieved.
     * @returns {string|undefined} The filename associated with the symbol, or undefined if the symbol is not found.
     */
    static getFileFilename(doc, symbol) {
        const targetFilename = symbol.substring(1, symbol.length - 1)
        assert('tagfile' in doc, 'tagfile should be in doc')
        const tagFileObj = doc['tagfile']
        if ('compound' in tagFileObj) {
            for (const compound of tagFileObj['compound']) {
                if (compound['name'] === targetFilename) {
                    return compound['filename']

                }
            }
        }
        return undefined
    }

    /**
     * Retrieves the filename URL of a given symbol from the provided documentation object.
     *
     * This function iterates over the 'compound' elements in the documentation object,
     * looking for a match with the provided symbol. If a match is found, the filename
     * associated with that compound is returned.
     *
     * For instance, it returns 'cpp/container/vector' for the symbol 'std::vector'.
     *
     * The function also handles namespaces and classes by checking if the symbol
     * starts with the name of the namespace or class.
     * If it does, it recursively calls itself with the current namespace or class
     * as the new object and the remaining part of the symbol.
     *
     * @param {Object} obj - The documentation object parsed from a tagfile.
     * @param {string} symbol - The symbol for which the filename is to be retrieved.
     * @param {string} curNamespace - The current namespace or class being checked.
     * @returns {string|undefined} The filename associated with the symbol, or undefined if the symbol is not found.
     */
    static getSymbolFilename(obj, symbol, curNamespace) {
        // Iterate <compound kind="class">
        if ('compound' in obj) {
            for (const compound of Array.isArray(obj['compound']) ? obj['compound'] : [obj['compound']]) {
                const kind = compound['@attributes']["kind"];
                if (kind !== 'class') {
                    continue
                }
                const name = compound['name'];
                if (symbol === name && 'filename' in compound) {
                    return compound['filename']
                }
            }
        }

        // Iterate <member kind="function">
        if ('member' in obj) {
            for (const member of Array.isArray(obj['member']) ? obj['member'] : [obj['member']]) {
                const kind = member['@attributes']["kind"];
                if (kind !== 'function') {
                    continue
                }
                const name = member['name']
                const qualifiedName = curNamespace ? curNamespace + "::" + name : name
                if (symbol === qualifiedName && 'anchorfile' in member) {
                    return member['anchorfile'] + (('anchor' in member && member['anchor']) ? `#${member["anchor"]}` : '')
                }
            }
        }

        // Recursively look for symbol in <compound kind="namespace"> or <compound kind="class">
        if ('compound' in obj) {
            for (const compound of Array.isArray(obj['compound']) ? obj['compound'] : [obj['compound']]) {
                const kind = compound['@attributes']["kind"];
                if (kind !== 'namespace' && kind !== 'class') {
                    continue
                }
                const name = compound['name'];
                if (symbol === name && 'filename' in compound) {
                    return compound['filename']
                }
                if (symbol.startsWith(name + '::')) {
                    const res = this.getSymbolFilename(compound, symbol, name)
                    if (res) {
                        return res
                    }
                    if (kind === 'class') {
                        // Result is undefined but parent is a class
                        // This means the class doesn't have a page for this
                        // member, so we return the class page
                        return compound['filename']
                    }
                }
            }
        }

        return undefined
    }

    /**
     * Splits a C++ symbol into its main symbol name, template parameters, and the rest of the symbol.
     *
     * This function is used to handle C++ symbols that are templates. It iterates over the symbol string,
     * keeping track of the level of nested templates. When it encounters a '<', it increments the level and
     * starts recording the template parameters. When it encounters a '>', it decrements the level and stops
     * recording the template parameters. The rest of the symbol is recorded after the template parameters.
     *
     * For instance, it splits 'std::vector<int>::iterator' into:
     * - main symbol name: 'std::vector'
     * - template parameters: ['int']
     * - rest: '::iterator'
     *
     * The extension uses this information to generate inline content with individual links
     * for the main symbol name, each template parameter, and the rest of the symbol.
     *
     * @param {string} symbol - The C++ symbol to split.
     * @returns {Object} An object with the main symbol name, the template parameters, and the rest of the symbol.
     */
    static splitCppSymbol(symbol) {
        let mainSymbolName = ''
        let curTemplate = ''
        let templateParameters = []
        let rest = ''
        let level = 0
        let inTemplateParameters = false

        for (let i = 0; i < symbol.length; i++) {
            let c = symbol[i];
            if (c === '<') {
                inTemplateParameters = true
                level++;
            } else if (c === '>') {
                level--;
            }

            if (level === 0) {
                if (!inTemplateParameters) {
                    mainSymbolName += c
                } else {
                    rest = symbol.substring(i + 1)
                    break
                }
            } else if (level === 1 && [',', '>', '<'].includes(c)) {
                if (curTemplate) {
                    if (c === '>') {
                        curTemplate += c
                    }
                    templateParameters.push(curTemplate.trim())
                    curTemplate = ''
                }
            } else {
                curTemplate += c
            }
        }

        if (curTemplate) {
            templateParameters.push(curTemplate.trim())
        }

        return {
            mainSymbolName: mainSymbolName,
            templateParameters: templateParameters,
            rest: rest
        };
    }

    /**
     * Creates a summary of the contents of an object.
     *
     * This static method of the `CppTagfilesExtension` class is used to create a summary of the contents of an object.
     * The summary is a copy of the object where all the properties whose type are Array or object are replaced with "[...]" or "{...}"
     * when the number of elements is greater than 3. Otherwise, the property is recursively replaced with its own summary.
     *
     * It takes two arguments: `obj` and `level`. `obj` is the object to be summarized. `level` is the depth level of the object properties.
     * The default value of `level` is 0.
     *
     * The method returns an object that is a summary of the input object.
     *
     * @param {Object} obj - The object to be summarized.
     * @param {number} [level=0] - The depth level of the object properties.
     * @returns {Object} An object that is a summary of the input object.
     */
    static objectSummary(obj, level = 0) {
        if (typeof obj !== 'object') {
            return `${obj}`
        }

        let summary = {}
        const maxPropertiesPerLevel = {
            0: 10,
            1: 5,
            2: 3,
            3: 2,
        }
        const maxProperties = maxPropertiesPerLevel[level] || 1
        if (Array.isArray(obj)) {
            if (obj.length > maxProperties) {
                return '[...]'
            } else {
                let arr = []
                for (const value of obj) {
                    if (typeof value === 'object') {
                        arr.push(CppTagfilesExtension.objectSummary(value, level + 1))
                    } else {
                        arr.push(value)
                    }
                }
                return arr
            }
        }
        for (const key in obj) {
            let value = obj[key]
            if (Array.isArray(value)) {
                if (value.length > maxProperties) {
                    value = '[...]'
                } else {
                    value = CppTagfilesExtension.objectSummary(value, level + 1)
                }
            } else if (typeof value === 'object') {
                if (Object.keys(value).length > maxProperties) {
                    value = '{...}'
                } else {
                    value = CppTagfilesExtension.objectSummary(value, level + 1)
                }
            }
            summary[key] = value
        }
        return summary
    }

}

module.exports = CppTagfilesExtension
