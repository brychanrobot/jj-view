/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LanguageRegistration } from 'shiki';

export const textprotoGrammar: LanguageRegistration = {
    name: 'textproto',
    scopeName: 'source.textproto',
    displayName: 'Protocol Buffer Text Format',
    patterns: [
        { include: '#comments' },
        { include: '#field-any' },
        { include: '#field-name' },
        { include: '#scalar-values' },
    ],
    repository: {
        comments: {
            patterns: [
                { match: '#.*$', name: 'comment.line.number-sign.textproto' },
                { match: '//.*$', name: 'comment.line.double-slash.textproto' },
            ],
        },
        'field-any': {
            match: '\\[[a-zA-Z0-9_./]+\\](?=\\s*[:{<])',
            name: 'entity.name.tag.textproto',
        },
        'field-name': {
            match: '\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*[:{<])',
            name: 'entity.other.attribute-name.textproto',
        },
        'scalar-values': {
            patterns: [
                { include: '#strings' },
                { include: '#booleans' },
                { include: '#numbers' },
                { include: '#enums' },
            ],
        },
        strings: {
            patterns: [
                {
                    begin: '"',
                    end: '"',
                    name: 'string.quoted.double.textproto',
                    patterns: [{ match: '\\\\.', name: 'constant.character.escape.textproto' }],
                },
                {
                    begin: "'",
                    end: "'",
                    name: 'string.quoted.single.textproto',
                    patterns: [{ match: '\\\\.', name: 'constant.character.escape.textproto' }],
                },
            ],
        },
        booleans: {
            match: '\\b(true|false|t|f)\\b',
            name: 'constant.language.boolean.textproto',
        },
        numbers: {
            match: '\\b[-+]?(?:0[xX][0-9a-fA-F]+|0[0-7]+|[0-9]+(?:\\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)\\b|\\b(NaN|Infinity|-Infinity)\\b',
            name: 'constant.numeric.textproto',
        },
        enums: {
            match: '\\b[A-Z_][A-Z0-9_]*\\b',
            name: 'constant.other.enum.textproto',
        },
    },
};

export async function loadTextprotoGrammar(): Promise<{ default: LanguageRegistration[] }> {
    return { default: [textprotoGrammar] };
}
