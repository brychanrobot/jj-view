/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LanguageRegistration } from 'shiki';

export async function loadBazelGrammar(): Promise<{ default: LanguageRegistration[] }> {
    const mod = await import('@shikijs/langs/python');
    const py = mod.default[0];
    return { default: [{ ...py, name: 'bazel', aliases: ['bzl', 'starlark'], displayName: 'Bazel' }] };
}
