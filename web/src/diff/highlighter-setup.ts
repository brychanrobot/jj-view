/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerCustomLanguage, registerCustomTheme } from '@pierre/diffs';
import pierreDarkRaw from '@pierre/theme/pierre-dark';
import pierreDarkSoftRaw from '@pierre/theme/pierre-dark-soft';
import pierreLightRaw from '@pierre/theme/pierre-light';
import pierreLightSoftRaw from '@pierre/theme/pierre-light-soft';
import { normalizeTheme, type ThemeRegistration } from 'shiki';

let isRegistered = false;

function toThemeRegistration(theme: typeof pierreDarkRaw): ThemeRegistration {
    return {
        name: theme.name,
        displayName: theme.displayName,
        type: theme.type,
        colors: { ...theme.colors },
        settings: theme.tokenColors.map((tc) => ({
            ...tc,
            scope: Array.isArray(tc.scope) ? [...tc.scope] : tc.scope,
            settings: { ...tc.settings },
        })),
    };
}

/**
 * Pre-registers bundled Shiki language grammars and Pierre themes with @pierre/diffs
 * so they are bundled into the web distribution and resolve synchronously/locally
 * without unbundled runtime HTTP dynamic imports.
 */
export function ensureHighlighterRegistered(): void {
    if (isRegistered) {
        return;
    }
    isRegistered = true;

    // Register Pierre Themes normalized for Shiki
    const pierreDark = normalizeTheme(toThemeRegistration(pierreDarkRaw));
    const pierreDarkSoft = normalizeTheme(toThemeRegistration(pierreDarkSoftRaw));
    const pierreLight = normalizeTheme(toThemeRegistration(pierreLightRaw));
    const pierreLightSoft = normalizeTheme(toThemeRegistration(pierreLightSoftRaw));

    registerCustomTheme('pierre-dark', () => Promise.resolve(pierreDark));
    registerCustomTheme('pierre-dark-soft', () => Promise.resolve(pierreDarkSoft));
    registerCustomTheme('pierre-light', () => Promise.resolve(pierreLight));
    registerCustomTheme('pierre-light-soft', () => Promise.resolve(pierreLightSoft));

    // Register Common Languages with extensions
    registerCustomLanguage('typescript', () => import('@shikijs/langs/typescript'), ['ts', 'mts', 'cts', 'tsx']);
    registerCustomLanguage('javascript', () => import('@shikijs/langs/javascript'), ['js', 'mjs', 'cjs', 'jsx']);
    registerCustomLanguage('json', () => import('@shikijs/langs/json'), ['json']);
    registerCustomLanguage('jsonc', () => import('@shikijs/langs/jsonc'), ['jsonc']);
    registerCustomLanguage('go', () => import('@shikijs/langs/go'), ['go']);
    registerCustomLanguage('rust', () => import('@shikijs/langs/rust'), ['rs']);
    registerCustomLanguage('python', () => import('@shikijs/langs/python'), ['py']);
    registerCustomLanguage('html', () => import('@shikijs/langs/html'), ['html', 'htm']);
    registerCustomLanguage('css', () => import('@shikijs/langs/css'), ['css']);
    registerCustomLanguage('markdown', () => import('@shikijs/langs/markdown'), ['md', 'markdown']);
    registerCustomLanguage('yaml', () => import('@shikijs/langs/yaml'), ['yaml', 'yml']);
    registerCustomLanguage('toml', () => import('@shikijs/langs/toml'), ['toml']);
    registerCustomLanguage('shellscript', () => import('@shikijs/langs/shellscript'), ['sh', 'bash', 'zsh']);
    registerCustomLanguage('diff', () => import('@shikijs/langs/diff'), ['diff', 'patch']);
    registerCustomLanguage('c', () => import('@shikijs/langs/c'), ['c', 'h']);
    registerCustomLanguage('cpp', () => import('@shikijs/langs/cpp'), ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx']);
    registerCustomLanguage('csharp', () => import('@shikijs/langs/csharp'), ['cs']);
    registerCustomLanguage('java', () => import('@shikijs/langs/java'), ['java']);
    registerCustomLanguage('dockerfile', () => import('@shikijs/langs/dockerfile'), ['dockerfile', 'Dockerfile']);
    registerCustomLanguage('xml', () => import('@shikijs/langs/xml'), ['xml', 'svg']);
    registerCustomLanguage('sql', () => import('@shikijs/langs/sql'), ['sql']);
}
