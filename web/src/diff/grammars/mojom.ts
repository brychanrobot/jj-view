/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LanguageRegistration } from 'shiki';

export const mojomGrammar: LanguageRegistration = {
    name: 'mojom',
    scopeName: 'source.mojom',
    displayName: 'Mojom',
    patterns: [
        { include: '#comments' },
        { include: '#attributes' },
        { include: '#keywords' },
        { include: '#builtin-types' },
        { include: '#constants' },
        { include: '#strings' },
        { include: '#numbers' },
        { include: '#operators' },
        { include: '#identifiers' },
    ],
    repository: {
        comments: {
            patterns: [
                { begin: '/\\*', end: '\\*/', name: 'comment.block.mojom' },
                { match: '//.*$', name: 'comment.line.double-slash.mojom' },
            ],
        },
        attributes: {
            begin: '\\[',
            end: '\\]',
            name: 'meta.attribute.mojom',
            patterns: [
                { match: '\\b[a-zA-Z_][a-zA-Z0-9_]*\\b(?=\\s*=)', name: 'entity.other.attribute-name.mojom' },
                { include: '#strings' },
                { include: '#numbers' },
                { include: '#constants' },
                { match: '\\b[a-zA-Z_][a-zA-Z0-9_]*\\b', name: 'variable.other.mojom' },
            ],
        },
        keywords: {
            match: '\\b(module|import|interface|struct|union|enum|const)\\b',
            name: 'keyword.other.mojom',
        },
        'builtin-types': {
            match: '\\b(bool|int8|int16|int32|int64|uint8|uint16|uint32|uint64|float|double|string|handle|array|map|pending_receiver|pending_remote|pending_associated_receiver|pending_associated_remote)\\b',
            name: 'support.type.primitive.mojom',
        },
        constants: {
            match: '\\b(true|false|default)\\b',
            name: 'constant.language.mojom',
        },
        strings: {
            begin: '"',
            end: '"',
            name: 'string.quoted.double.mojom',
            patterns: [{ match: '\\\\.', name: 'constant.character.escape.mojom' }],
        },
        numbers: {
            match: '\\b[-+]?(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\\.[0-9]+)?)\\b',
            name: 'constant.numeric.mojom',
        },
        operators: {
            match: '=>|;|:|,|\\?|<|>|\\{|\\}|\\(|\\)|\\[|\\]|=',
            name: 'keyword.operator.mojom',
        },
        identifiers: {
            match: '\\b[a-zA-Z_][a-zA-Z0-9_]*\\b',
            name: 'variable.other.mojom',
        },
    },
};

export async function loadMojomGrammar(): Promise<{ default: LanguageRegistration[] }> {
    return { default: [mojomGrammar] };
}
