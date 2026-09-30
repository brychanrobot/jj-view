/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LanguageRegistration } from 'shiki';

export const proguardGrammar: LanguageRegistration = {
    name: 'proguard',
    scopeName: 'source.proguard',
    displayName: 'ProGuard',
    patterns: [
        { match: '#.*$', name: 'comment.line.number-sign.proguard' },
        { match: '^\\s*(-[a-zA-Z0-9_-]+)', name: 'keyword.other.flag.proguard' },
        {
            match: '\\b(public|private|protected|static|final|abstract|volatile|transient|native|synchronized|strictfp)\\b',
            name: 'storage.modifier.proguard',
        },
        { match: '\\b(class|interface|enum|@interface|extends|implements)\\b', name: 'storage.type.proguard' },
        {
            begin: '"',
            end: '"',
            name: 'string.quoted.double.proguard',
            patterns: [{ match: '\\\\.', name: 'constant.character.escape.proguard' }],
        },
        {
            begin: "'",
            end: "'",
            name: 'string.quoted.single.proguard',
            patterns: [{ match: '\\\\.', name: 'constant.character.escape.proguard' }],
        },
        { match: '(\\*\\*|\\*|\\?)', name: 'keyword.operator.wildcard.proguard' },
    ],
    repository: {},
};

export async function loadProguardGrammar(): Promise<{ default: LanguageRegistration[] }> {
    return { default: [proguardGrammar] };
}
