/*
    Copyright (c) 2023 Alan de Freitas (alandefreitas@gmail.com)

    Distributed under the Boost Software License, Version 1.0. (See accompanying
    file LICENSE_1_0.txt or copy at http://www.boost.org/LICENSE_1_0.txt)

    Official repository: https://github.com/boostorg/site-docs
*/

/**
 * Converts a string from camel case or pascal case to snake case.
 * @param {string} str - The input string in camel case or pascal case.
 * @returns {string} The string in snake case.
 */
function toSnakeCase(str) {
    // Replace all uppercase letters with an underscore followed by their lowercase version
    // If the uppercase letter is the first character, only return the lowercase letter
    return str.replace(/[A-Z]/g, (letter, index) => {
        return index === 0 ? letter.toLowerCase() : '_' + letter.toLowerCase();
    }).replace('-', '_');
}

/**
 * Convert a string to PascalCase.
 * @param {string} inputString - The input string to convert.
 * @returns {string} The input string converted to PascalCase.
 */
function toPascalCase(inputString) {
    // Replace all occurrences of separator followed by a character with uppercase version of the character
    // First argument to replace() is a regex to match the separator and character
    // Second argument to replace() is a callback function to transform the matched string
    const pascalCaseString = inputString.replace(/(_|-|\s)(.)/g, function (match, separator, char) {
        return char.toUpperCase();
    });

    // Uppercase the first character of the resulting string
    return pascalCaseString.replace(/(^.)/, function (char) {
        return char.toUpperCase();
    });
}

/**
 * Converts a given target name to the Boost library's text format.
 *
 * This function formats the target name according to Boost library conventions.
 * It handles special cases for certain targets and applies a general rule for others.
 * The general rule converts the target name to PascalCase and prefixes it with "Boost.".
 *
 * @param {string} target - The name of the target library.
 * @returns {string} - The formatted target name in Boost text format.
 */
function toBoostTextFormat(target) {
    // Convert the target name to lowercase for case-insensitive comparison
    const lcTarget = target.toLowerCase();

    // Handle special cases for specific target names
    if (['build', 'b2'].includes(lcTarget)) {
        return 'B2';
    }
    if (lcTarget === 'url') {
        return 'Boost.URL';
    }

    // Apply the general rule: prefix with "Boost." and convert to PascalCase
    return `Boost.${toPascalCase(target)}`;
}

/**
 * Generates a Boost documentation link for a given target with the appropriate format.
 *
 * This function constructs a URL to a Boost library or tool based on the provided attributes and target name.
 * It determines whether the target is a tool or a library, formats the title, and includes any additional attributes
 * in the link text.
 *
 * @param {Object} attr - An object containing attributes for the link, including optional positional data.
 * @param {string} target - The name of the target library or tool.
 * @returns {string} - The formatted URL linking to the Boost documentation for the specified target.
 */
function generateBoostLink(target, attr) {
    const title = attr['$positional'] ? attr['$positional'][0] : toBoostTextFormat(target);
    const boost_tools = ['auto_index', 'bcp', 'boostbook', 'boostdep', 'boost_install', 'build', 'check_build', 'cmake', 'docca', 'inspect', 'litre', 'quickbook'];
    const is_tool = boost_tools.includes(toSnakeCase(target));
    const pathPrefix = `${is_tool ? 'tools' : 'libs'}`;
    const attributes = Object.keys(attr)
        .filter(key => !key.startsWith('$'))
        .map(key => `${key}=${attr[key]}`)
        .join(',');
    const titleAndAttributes = attributes ? `${title},${attributes}` : `${title}`;
    return `https://www.boost.org/${pathPrefix}/${toSnakeCase(target)}[${titleAndAttributes}]`;
}

/**
 * Creates an inline Boost library or tool link with the appropriate format.
 *
 * This function is designed to process a given target name and attributes, determine if the target is a Boost library or tool,
 * and generate a properly formatted inline link for the Boost documentation. It uses the provided or derived title and
 * attributes to construct the link text.
 *
 * @returns {void}
 */
function createBoostInline() {
    const self = this;
    self.process(function (parent, target, attr) {
        return self.createInline(parent, 'quoted', generateBoostLink(target, attr));
    });
}

/**
 * Registers an inline macro named "boost" with the given Asciidoctor registry.
 * This macro creates a link to the corresponding Boost C++ library.
 *
 * @param {Object} registry - The Asciidoctor registry to register the macro with.
 * @throws {Error} If registry is not defined.
 * @example
 * const asciidoctor = require('asciidoctor');
 * const registry = asciidoctor.Extensions.create();
 * registerBoostMacro(registry);
 */
module.exports = function (registry) {
    // Make sure registry is defined
    if (!registry) {
        throw new Error('registry must be defined');
    }

    /**
     * Processes the "boost" inline macro.
     * If the "title" attribute is specified, use it as the link text.
     * Otherwise, use the capitalized target as the link text.
     * The link URL is constructed based on the snake_case version of the target.
     *
     * @param {Object} parent - The parent node of the inline macro.
     * @param {string} target - The target of the inline macro.
     * @param {Object} attr - The attributes of the inline macro.
     * @returns {Object} An inline node representing the link.
     */
    registry.inlineMacro('boost', createBoostInline);
}

module.exports.generateBoostLink = generateBoostLink
