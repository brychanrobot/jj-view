/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LanguageRegistration } from 'shiki';
import { mojomGrammar } from './mojom';
import { textprotoGrammar } from './textproto';

interface RawStringEmbeddedLanguage {
    readonly id: string;
    readonly tags: readonly string[];
    readonly scopeName: string;
}

/**
 * Embedded languages recognized via C++ raw string delimiters (e.g. `R"js(...)js"`,
 * `R"html(...)html"`, `R"sql(...)sql"`, `R"pb(...)pb"`), including optional suffix
 * disambiguators such as `R"js_template(...)js_template"`.
 */
export const CPP_RAW_STRING_LANGUAGES: readonly RawStringEmbeddedLanguage[] = [
    { id: 'js', tags: ['js', 'javascript', 'mjs', 'cjs'], scopeName: 'source.js' },
    { id: 'ts', tags: ['ts', 'typescript'], scopeName: 'source.ts' },
    { id: 'html', tags: ['html', 'htm'], scopeName: 'text.html.basic' },
    { id: 'css', tags: ['css'], scopeName: 'source.css' },
    { id: 'json', tags: ['json'], scopeName: 'source.json' },
    { id: 'jsonc', tags: ['jsonc'], scopeName: 'source.json.comments' },
    { id: 'sql', tags: ['sql'], scopeName: 'source.sql' },
    { id: 'xml', tags: ['xml', 'svg'], scopeName: 'text.xml' },
    { id: 'python', tags: ['py', 'python'], scopeName: 'source.python' },
    { id: 'shell', tags: ['sh', 'bash', 'shell', 'zsh'], scopeName: 'source.shell' },
    { id: 'proto', tags: ['proto', 'protobuf'], scopeName: 'source.proto' },
    { id: 'textproto', tags: ['pb', 'pbtxt', 'textproto', 'prototxt'], scopeName: 'source.textproto' },
    { id: 'mojom', tags: ['mojom'], scopeName: 'source.mojom' },
    { id: 'gn', tags: ['gn', 'gni'], scopeName: 'source.gn' },
    { id: 'markdown', tags: ['md', 'markdown'], scopeName: 'text.html.markdown' },
    { id: 'yaml', tags: ['yaml', 'yml'], scopeName: 'source.yaml' },
];

type GrammarModuleLoader = () => Promise<{ default: LanguageRegistration[] }>;

const EMBEDDED_GRAMMAR_LOADERS: readonly GrammarModuleLoader[] = [
    () => import('@shikijs/langs/javascript'),
    () => import('@shikijs/langs/typescript'),
    () => import('@shikijs/langs/html'),
    () => import('@shikijs/langs/css'),
    () => import('@shikijs/langs/json'),
    () => import('@shikijs/langs/jsonc'),
    () => import('@shikijs/langs/sql'),
    () => import('@shikijs/langs/xml'),
    () => import('@shikijs/langs/python'),
    () => import('@shikijs/langs/shellscript'),
    () => import('@shikijs/langs/proto'),
    () => import('@shikijs/langs/gn'),
    () => import('@shikijs/langs/markdown'),
    () => import('@shikijs/langs/yaml'),
];

const loadBaseCppGrammar: GrammarModuleLoader = () => import('@shikijs/langs/cpp');

type GrammarRule = NonNullable<LanguageRegistration['patterns']>[number];

export function buildCppRawStringRules(): GrammarRule[] {
    return CPP_RAW_STRING_LANGUAGES.map((spec) => {
        const tagAlternation = spec.tags.join('|');
        return {
            begin: `((?:[LUu]8?)?R)"((?i:${tagAlternation})(?:[-_][0-9A-Za-z_-]*)?)\\(`,
            beginCaptures: {
                '0': { name: 'punctuation.definition.string.begin.cpp' },
                '1': { name: 'meta.encoding.cpp' },
            },
            end: '\\)(\\2)"',
            endCaptures: {
                '0': { name: 'punctuation.definition.string.end.cpp' },
            },
            name: `meta.string.quoted.double.raw.${spec.id}.cpp`,
            patterns: [{ include: spec.scopeName }],
        };
    });
}

function injectRawStringRulesIntoGrammar(grammar: LanguageRegistration, rules: readonly GrammarRule[]): void {
    const stringContext = grammar.repository?.string_context;
    if (!stringContext || !('patterns' in stringContext) || !Array.isArray(stringContext.patterns)) {
        return;
    }

    const patterns = stringContext.patterns;
    const genericRawStringIndex = patterns.findIndex(
        (rule) => typeof rule.begin === 'string' && rule.begin.includes('R)"\\('),
    );
    const insertIndex = genericRawStringIndex >= 0 ? genericRawStringIndex : patterns.length;
    patterns.splice(insertIndex, 0, ...rules);
}

let cachedCppGrammarsPromise: Promise<{ default: LanguageRegistration[] }> | null = null;

/**
 * Loads the C++ Shiki grammar augmented with embedded language syntax highlighting
 * for tagged raw string literals (e.g. `R"js(...)js"`, `R"html(...)html"`, `R"sql(...)sql"`).
 * Includes the referenced embedded LanguageRegistration objects so both main-thread
 * and Web Worker highlighters can resolve the included TextMate scopes via `loadLanguageSync`.
 */
export function loadCppWithRawStringsGrammar(): Promise<{ default: LanguageRegistration[] }> {
    if (cachedCppGrammarsPromise) {
        return cachedCppGrammarsPromise;
    }

    cachedCppGrammarsPromise = (async () => {
        const [cppModule, ...embeddedModules] = await Promise.all([
            loadBaseCppGrammar(),
            ...EMBEDDED_GRAMMAR_LOADERS.map((loader) => loader()),
        ]);

        const rawStringRules = buildCppRawStringRules();
        const cppGrammars = structuredClone(cppModule.default);
        for (const grammar of cppGrammars) {
            if (grammar.scopeName === 'source.cpp' || grammar.scopeName === 'source.cpp.embedded.macro') {
                injectRawStringRulesIntoGrammar(grammar, rawStringRules);
            }
        }

        const seenNames = new Set<string>();
        const combined: LanguageRegistration[] = [];

        const appendUnique = (grammars: readonly LanguageRegistration[]) => {
            for (const grammar of grammars) {
                if (seenNames.has(grammar.name)) {
                    continue;
                }
                seenNames.add(grammar.name);
                combined.push(grammar);
            }
        };

        for (const mod of embeddedModules) {
            appendUnique(mod.default);
        }
        appendUnique([textprotoGrammar, mojomGrammar]);

        // Place C++ and its immediate sub-grammars last so all included scopes are registered first.
        for (const grammar of cppGrammars) {
            if (seenNames.has(grammar.name)) {
                const existingIdx = combined.findIndex((g) => g.name === grammar.name);
                if (existingIdx >= 0) {
                    combined.splice(existingIdx, 1);
                }
            }
            seenNames.add(grammar.name);
            combined.push(grammar);
        }

        return { default: combined };
    })();

    return cachedCppGrammarsPromise;
}
