/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerCustomLanguage, registerCustomTheme } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker';
import { normalizeTheme, type ThemeRegistration } from 'shiki';
import { loadBazelGrammar } from './grammars/bazel';
import { CPP_RAW_STRING_LANGUAGES, loadCppWithRawStringsGrammar } from './grammars/cpp-raw-strings';
import { loadMojomGrammar, mojomGrammar } from './grammars/mojom';
import { loadProguardGrammar, proguardGrammar } from './grammars/proguard';
import { loadTextprotoGrammar, textprotoGrammar } from './grammars/textproto';

export {
    CPP_RAW_STRING_LANGUAGES,
    loadBazelGrammar,
    loadCppWithRawStringsGrammar,
    loadMojomGrammar,
    loadProguardGrammar,
    loadTextprotoGrammar,
    mojomGrammar,
    proguardGrammar,
    textprotoGrammar,
};

interface RawPierreTheme {
    name: string;
    displayName?: string;
    type?: 'light' | 'dark';
    colors?: Readonly<Record<string, string>>;
    tokenColors?: readonly {
        readonly scope?: string | readonly string[];
        readonly settings?: Readonly<Record<string, string>>;
    }[];
}

interface ThemeModule {
    default: ThemeRegistration;
}

type ThemeLoader = () => Promise<ThemeModule>;

let isRegistered = false;

const normalizedPierreThemes = new Map<string, ThemeRegistration>();
const normalizedShikiThemes = new Map<string, ThemeRegistration>();

let diffWorkerPoolManager: WorkerPoolManager | undefined;
let diffWorkerBlobUrl: string | undefined;
let initWorkerPromise: Promise<void> | null = null;

export async function initPierreWorker(): Promise<void> {
    if (typeof window === 'undefined' || diffWorkerBlobUrl) {
        return;
    }
    if (initWorkerPromise) {
        return initWorkerPromise;
    }
    initWorkerPromise = (async () => {
        try {
            const response = await fetch('/dist/pierre-worker.js');
            if (!response.ok) {
                console.warn('[Pierre Worker] Failed to fetch /dist/pierre-worker.js:', response.statusText);
                return;
            }
            const text = await response.text();
            const blob = new Blob([text], { type: 'application/javascript' });
            diffWorkerBlobUrl = URL.createObjectURL(blob);
        } catch (err) {
            console.warn('[Pierre Worker] Could not create worker blob URL:', err);
        }
    })();
    return initWorkerPromise;
}

export function getOrCreateDiffWorkerPool(themeName: string): WorkerPoolManager | undefined {
    if (typeof window === 'undefined' || !diffWorkerBlobUrl) {
        return undefined;
    }
    const workerUrl = diffWorkerBlobUrl;
    if (!diffWorkerPoolManager) {
        try {
            diffWorkerPoolManager = getOrCreateWorkerPoolSingleton({
                poolOptions: {
                    workerFactory: () => new Worker(workerUrl),
                    poolSize: Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 2) - 1)),
                },
                highlighterOptions: {
                    theme: themeName,
                    preferredHighlighter: 'shiki-js',
                    // Required for `Editor.edit()` to reuse the worker's highlighted output.
                    // Without it the editor's `beginEditSession` sees mismatched render
                    // options, drops the cache, and re-highlights the whole file synchronously.
                    useTokenTransformer: true,
                },
            });
        } catch (err) {
            console.warn('[Pierre Worker] Failed to initialize worker pool:', err);
            return undefined;
        }
    } else {
        void diffWorkerPoolManager.setRenderOptions({ theme: themeName });
    }
    return diffWorkerPoolManager;
}

interface RawPierreThemeModule {
    default: RawPierreTheme;
}

type PierreThemeLoader = () => Promise<RawPierreThemeModule>;

// Lazy on purpose: static imports put all ten themes on the startup critical
// path as eagerly-fetched chunks, and only one is ever active.
const PIERRE_THEME_LOADERS: Record<string, PierreThemeLoader> = {
    'pierre-dark': () => import('@pierre/theme/pierre-dark'),
    'pierre-dark-soft': () => import('@pierre/theme/pierre-dark-soft'),
    'pierre-dark-vibrant': () => import('@pierre/theme/pierre-dark-vibrant'),
    'pierre-dark-protanopia-deuteranopia': () => import('@pierre/theme/pierre-dark-protanopia-deuteranopia'),
    'pierre-dark-tritanopia': () => import('@pierre/theme/pierre-dark-tritanopia'),
    'pierre-light': () => import('@pierre/theme/pierre-light'),
    'pierre-light-soft': () => import('@pierre/theme/pierre-light-soft'),
    'pierre-light-vibrant': () => import('@pierre/theme/pierre-light-vibrant'),
    'pierre-light-protanopia-deuteranopia': () => import('@pierre/theme/pierre-light-protanopia-deuteranopia'),
    'pierre-light-tritanopia': () => import('@pierre/theme/pierre-light-tritanopia'),
};

const DEFAULT_PIERRE_THEME = 'pierre-dark-soft';

const SHIKI_THEME_LOADERS: Record<string, ThemeLoader> = {
    'github-dark': () => import('@shikijs/themes/github-dark'),
    'github-dark-dimmed': () => import('@shikijs/themes/github-dark-dimmed'),
    'catppuccin-mocha': () => import('@shikijs/themes/catppuccin-mocha'),
    'catppuccin-macchiato': () => import('@shikijs/themes/catppuccin-macchiato'),
    'catppuccin-frappe': () => import('@shikijs/themes/catppuccin-frappe'),
    dracula: () => import('@shikijs/themes/dracula'),
    'dracula-soft': () => import('@shikijs/themes/dracula-soft'),
    'tokyo-night': () => import('@shikijs/themes/tokyo-night'),
    nord: () => import('@shikijs/themes/nord'),
    'one-dark-pro': () => import('@shikijs/themes/one-dark-pro'),
    'solarized-dark': () => import('@shikijs/themes/solarized-dark'),
    monokai: () => import('@shikijs/themes/monokai'),
    'ayu-dark': () => import('@shikijs/themes/ayu-dark'),
    'ayu-mirage': () => import('@shikijs/themes/ayu-mirage'),
    vesper: () => import('@shikijs/themes/vesper'),
    poimandres: () => import('@shikijs/themes/poimandres'),
    'rose-pine': () => import('@shikijs/themes/rose-pine'),
    'rose-pine-moon': () => import('@shikijs/themes/rose-pine-moon'),
    'everforest-dark': () => import('@shikijs/themes/everforest-dark'),
    'gruvbox-dark-medium': () => import('@shikijs/themes/gruvbox-dark-medium'),
    'kanagawa-wave': () => import('@shikijs/themes/kanagawa-wave'),
    'night-owl': () => import('@shikijs/themes/night-owl'),
    'github-light': () => import('@shikijs/themes/github-light'),
    'github-light-default': () => import('@shikijs/themes/github-light-default'),
    'catppuccin-latte': () => import('@shikijs/themes/catppuccin-latte'),
    'one-light': () => import('@shikijs/themes/one-light'),
    'solarized-light': () => import('@shikijs/themes/solarized-light'),
    'rose-pine-dawn': () => import('@shikijs/themes/rose-pine-dawn'),
    'everforest-light': () => import('@shikijs/themes/everforest-light'),
    'gruvbox-light-medium': () => import('@shikijs/themes/gruvbox-light-medium'),
    'vitesse-light': () => import('@shikijs/themes/vitesse-light'),
    'light-plus': () => import('@shikijs/themes/light-plus'),
};

function toThemeRegistration(theme: RawPierreTheme): ThemeRegistration {
    return {
        name: theme.name,
        displayName: theme.displayName,
        type: theme.type ?? (theme.name.includes('light') ? 'light' : 'dark'),
        colors: theme.colors ? { ...theme.colors } : {},
        settings: (theme.tokenColors ?? []).map((tc) => {
            let scope: string | string[] | undefined;
            if (typeof tc.scope === 'string') {
                scope = tc.scope;
            } else if (Array.isArray(tc.scope)) {
                scope = Array.from(tc.scope);
            }
            return {
                ...tc,
                scope,
                settings: tc.settings ? { ...tc.settings } : {},
            };
        }),
    };
}

/**
 * Pre-registers Shiki language grammars and Shiki theme loaders with @pierre/diffs.
 * Pierre themes ship built-in with @pierre/diffs and are only loaded (lazily) by
 * loadTheme() when the app needs their colors for CSS theming.
 */
interface ThemeWindow extends Window {
    __jjRegisteredThemes?: Set<string>;
    __jjRegisteredLanguages?: Set<string>;
}

export function ensureHighlighterRegistered(): void {
    void initPierreWorker();
    if (isRegistered) {
        return;
    }
    isRegistered = true;

    const globalWin = typeof window !== 'undefined' ? (window as ThemeWindow) : undefined;
    let registeredThemes: Set<string>;
    let registeredLanguages: Set<string>;
    if (globalWin) {
        if (!globalWin.__jjRegisteredThemes) {
            globalWin.__jjRegisteredThemes = new Set<string>();
        }
        registeredThemes = globalWin.__jjRegisteredThemes;

        if (!globalWin.__jjRegisteredLanguages) {
            globalWin.__jjRegisteredLanguages = new Set<string>();
        }
        registeredLanguages = globalWin.__jjRegisteredLanguages;
    } else {
        registeredThemes = new Set<string>();
        registeredLanguages = new Set<string>();
    }

    // Pierre themes are not registered with @pierre/diffs (it ships them
    // built-in) and are normalized lazily in loadTheme() for app CSS theming.

    // Register all Shiki theme loaders with Pierre once
    for (const [name, loader] of Object.entries(SHIKI_THEME_LOADERS)) {
        if (!registeredThemes.has(name)) {
            registeredThemes.add(name);
            registerCustomTheme(name, async () => {
                const cached = normalizedShikiThemes.get(name);
                if (cached) {
                    return cached;
                }
                const mod = await loader();
                const normalized = normalizeTheme(mod.default);
                normalizedShikiThemes.set(name, normalized);
                return normalized;
            });
        }
    }

    // Register Common Languages with extensions once
    const registerLangOnce = (lang: string, loader: Parameters<typeof registerCustomLanguage>[1], exts: string[]) => {
        if (!registeredLanguages.has(lang)) {
            registeredLanguages.add(lang);
            registerCustomLanguage(lang, loader, exts);
        }
    };

    registerLangOnce('typescript', () => import('@shikijs/langs/typescript'), ['ts', 'mts', 'cts', 'tsx']);
    registerLangOnce('javascript', () => import('@shikijs/langs/javascript'), ['js', 'mjs', 'cjs', 'jsx']);
    registerLangOnce('json', () => import('@shikijs/langs/json'), ['json', 'arb']);
    registerLangOnce('jsonc', () => import('@shikijs/langs/jsonc'), ['jsonc']);
    registerLangOnce('go', () => import('@shikijs/langs/go'), ['go']);
    registerLangOnce('rust', () => import('@shikijs/langs/rust'), ['rs']);
    registerLangOnce('python', () => import('@shikijs/langs/python'), ['py']);
    registerLangOnce('html', () => import('@shikijs/langs/html'), ['html', 'htm']);
    registerLangOnce('css', () => import('@shikijs/langs/css'), ['css']);
    registerLangOnce('markdown', () => import('@shikijs/langs/markdown'), ['md', 'markdown']);
    registerLangOnce('yaml', () => import('@shikijs/langs/yaml'), ['yaml', 'yml', 'pubspec.lock']);
    registerLangOnce('toml', () => import('@shikijs/langs/toml'), ['toml']);
    registerLangOnce('shellscript', () => import('@shikijs/langs/shellscript'), ['sh', 'bash', 'zsh', 'gradlew']);
    registerLangOnce('bat', () => import('@shikijs/langs/bat'), ['bat', 'cmd', 'gradlew.bat']);
    registerLangOnce('diff', () => import('@shikijs/langs/diff'), ['diff', 'patch']);
    registerLangOnce('c', () => import('@shikijs/langs/c'), ['c']);
    registerLangOnce('cpp', loadCppWithRawStringsGrammar, ['cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'mm']);
    registerLangOnce('csharp', () => import('@shikijs/langs/csharp'), ['cs']);
    registerLangOnce('java', () => import('@shikijs/langs/java'), ['java', 'aidl']);
    registerLangOnce('dockerfile', () => import('@shikijs/langs/dockerfile'), ['dockerfile', 'Dockerfile']);
    registerLangOnce('xml', () => import('@shikijs/langs/xml'), ['xml', 'svg', 'AndroidManifest.xml']);
    registerLangOnce('sql', () => import('@shikijs/langs/sql'), ['sql']);
    registerLangOnce('svelte', () => import('@shikijs/langs/svelte'), ['svelte']);
    registerLangOnce('vue', () => import('@shikijs/langs/vue'), ['vue']);
    registerLangOnce('gn', () => import('@shikijs/langs/gn'), ['gn', 'gni', '.gn', 'BUILD.gn']);
    registerLangOnce('mojom', loadMojomGrammar, ['mojom']);

    registerLangOnce('bazel', loadBazelGrammar, [
        'bzl',
        'bazel',
        'star',
        'starlark',
        'BUILD',
        'BUILD.bazel',
        'WORKSPACE',
        'WORKSPACE.bazel',
        'WORKSPACE.bzlmod',
        'MODULE.bazel',
        'REPO.bazel',
    ]);
    registerLangOnce('starlark', loadBazelGrammar, []);
    registerLangOnce('bzl', loadBazelGrammar, []);

    registerLangOnce('protobuf', () => import('@shikijs/langs/proto'), ['proto', 'protobuf']);
    registerLangOnce('proto', () => import('@shikijs/langs/proto'), []);

    registerLangOnce('textproto', loadTextprotoGrammar, ['textproto', 'pbtxt', 'prototxt']);
    registerLangOnce('pbtxt', loadTextprotoGrammar, []);

    registerLangOnce('kotlin', () => import('@shikijs/langs/kotlin'), [
        'kt',
        'kts',
        'build.gradle.kts',
        'settings.gradle.kts',
    ]);
    registerLangOnce('dart', () => import('@shikijs/langs/dart'), ['dart']);
    registerLangOnce('groovy', () => import('@shikijs/langs/groovy'), [
        'groovy',
        'gvy',
        'gradle',
        'build.gradle',
        'settings.gradle',
    ]);
    registerLangOnce('properties', () => import('@shikijs/langs/properties'), [
        'properties',
        'gradle.properties',
        'local.properties',
        'gradle-wrapper.properties',
    ]);
    registerLangOnce('proguard', loadProguardGrammar, ['pro', 'proguard-rules.pro', 'consumer-rules.pro']);
}

/** Loads a chunk once, retrying a single time: a stale chunk hash right after a daemon update is the usual failure. */
async function loadWithRetry<T>(name: string, loader: () => Promise<T>): Promise<T | undefined> {
    try {
        return await loader();
    } catch (err) {
        console.warn(`Dynamic load of theme "${name}" failed, retrying...`, err);
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
            return await loader();
        } catch (retryErr) {
            console.error(`Failed to load theme "${name}":`, retryErr);
            return undefined;
        }
    }
}

async function loadPierreTheme(name: string): Promise<ThemeRegistration | undefined> {
    const cached = normalizedPierreThemes.get(name);
    if (cached) {
        return cached;
    }
    const loader = PIERRE_THEME_LOADERS[name];
    if (!loader) {
        return undefined;
    }
    const mod = await loadWithRetry(name, loader);
    if (!mod) {
        return undefined;
    }
    const normalized = normalizeTheme(toThemeRegistration(mod.default));
    normalizedPierreThemes.set(name, normalized);
    return normalized;
}

async function loadShikiTheme(name: string): Promise<ThemeRegistration | undefined> {
    const cached = normalizedShikiThemes.get(name);
    if (cached) {
        return cached;
    }
    const loader = SHIKI_THEME_LOADERS[name];
    if (!loader) {
        return undefined;
    }
    const mod = await loadWithRetry(name, loader);
    if (!mod) {
        return undefined;
    }
    const normalized = normalizeTheme(mod.default);
    normalizedShikiThemes.set(name, normalized);
    return normalized;
}

/**
 * Loads a ThemeRegistration by name, resolving Pierre or Shiki themes.
 * Falls back to the default Pierre theme for unknown names or load failures.
 */
export async function loadTheme(name: string): Promise<ThemeRegistration> {
    ensureHighlighterRegistered();

    const theme = (await loadPierreTheme(name)) ?? (await loadShikiTheme(name));
    if (theme) {
        return theme;
    }

    const fallback = await loadPierreTheme(DEFAULT_PIERRE_THEME);
    if (fallback) {
        return fallback;
    }
    // Both the requested theme and the default chunk failed to load (e.g. the
    // daemon was updated under us). Return a minimal theme so the app still
    // renders; the next reload picks up matching chunks.
    return normalizeTheme({ name: DEFAULT_PIERRE_THEME, type: 'dark', colors: {}, settings: [] });
}

const LIGHT_THEME_NAMES = new Set([
    'pierre-light',
    'pierre-light-soft',
    'pierre-light-vibrant',
    'pierre-light-protanopia-deuteranopia',
    'pierre-light-tritanopia',
    'github-light',
    'github-light-default',
    'catppuccin-latte',
    'one-light',
    'solarized-light',
    'rose-pine-dawn',
    'everforest-light',
    'gruvbox-light-medium',
    'vitesse-light',
    'light-plus',
]);

/**
 * Returns true if the given theme name corresponds to a light color scheme.
 */
export function isLightTheme(themeName: string): boolean {
    return LIGHT_THEME_NAMES.has(themeName) || themeName.includes('light');
}

/**
 * Dynamically applies a ThemeRegistration to skin the entire standalone web application
 * by updating VS Code CSS custom properties (--vscode-*) and body theme classes.
 */
export function applyAppTheme(theme: ThemeRegistration): void {
    if (typeof document === 'undefined') {
        return;
    }

    const themeName = theme.name ?? 'pierre-dark-soft';
    const isLight = theme.type === 'light' || isLightTheme(themeName);
    document.body.classList.remove(isLight ? 'vscode-dark' : 'vscode-light');
    document.body.classList.add(isLight ? 'vscode-light' : 'vscode-dark');
    document.documentElement.setAttribute('data-theme', themeName);

    const colors = theme.colors || {};
    const rules: string[] = [];

    // Dynamically translate all theme colors to --vscode-* CSS custom properties
    for (const [key, value] of Object.entries(colors)) {
        if (typeof value === 'string') {
            const varName = `--vscode-${key.replace(/\./g, '-')}`;
            rules.push(`  ${varName}: ${value};`);
        }
    }

    // Intelligent fallbacks for key UI surfaces if not explicitly in theme.colors
    const editorBg = colors['editor.background'] || (isLight ? '#ffffff' : '#1e1e1e');
    const editorFg = colors['editor.foreground'] || colors.foreground || (isLight ? '#333333' : '#d4d4d4');
    const sideBarBg = colors['sideBar.background'] || editorBg;
    const sideBarFg = colors['sideBar.foreground'] || editorFg;
    const sideBarBorder =
        colors['sideBar.border'] ||
        colors['editorGroup.border'] ||
        colors['widget.border'] ||
        (isLight ? '#ededed' : '#262626');
    const inputBg = colors['input.background'] || (isLight ? '#f5f5f5' : '#262626');
    const inputFg = colors['input.foreground'] || editorFg;
    const inputBorder = colors['input.border'] || sideBarBorder;
    const buttonBg = colors['button.background'] || colors.focusBorder || (isLight ? '#007acc' : '#0e639c');
    const buttonFg = colors['button.foreground'] || '#ffffff';
    const statusBarBg = colors['statusBar.background'] || sideBarBg;
    const statusBarFg = colors['statusBar.foreground'] || colors.descriptionForeground || editorFg;
    const statusBarBorder = colors['statusBar.border'] || sideBarBorder;

    const defaultColorMappings: Record<string, string> = {
        'sideBar.background': sideBarBg,
        'sideBar.foreground': sideBarFg,
        'sideBar.border': sideBarBorder,
        'panel.background': editorBg,
        'panel.border': sideBarBorder,
        'editorGroupHeader.tabsBackground': sideBarBg,
        'editorGroupHeader.tabsBorder': sideBarBorder,
        'titleBar.activeBackground': sideBarBg,
        'titleBar.activeForeground': editorFg,
        'titleBar.border': sideBarBorder,
        'tab.activeBackground': editorBg,
        'tab.activeForeground': editorFg,
        'tab.inactiveBackground': sideBarBg,
        'tab.inactiveForeground': colors.descriptionForeground || editorFg,
        'tab.border': sideBarBorder,
        'input.background': inputBg,
        'input.foreground': inputFg,
        'input.border': inputBorder,
        'dropdown.background': inputBg,
        'dropdown.border': inputBorder,
        'dropdown.foreground': inputFg,
        'button.background': buttonBg,
        'button.foreground': buttonFg,
        'statusBar.background': statusBarBg,
        'statusBar.foreground': statusBarFg,
        'statusBar.border': statusBarBorder,
        'widget.border': sideBarBorder,
        'editorWarning.foreground': colors['editorWarning.foreground'] || (isLight ? '#bf8803' : '#cca700'),
        'editorError.foreground': colors['editorError.foreground'] || (isLight ? '#e51400' : '#f14c4c'),
        'editorInfo.foreground': colors['editorInfo.foreground'] || (isLight ? '#1a85ff' : '#3794ff'),
        'testing.iconPassed':
            colors['testing.iconPassed'] ||
            colors['gitDecoration.addedResourceForeground'] ||
            (isLight ? '#388a34' : '#73c991'),
        'testing.iconFailed':
            colors['testing.iconFailed'] ||
            colors['gitDecoration.deletedResourceForeground'] ||
            (isLight ? '#e51400' : '#f14c4c'),
        'textLink.foreground': colors['textLink.foreground'] || (isLight ? '#006ab1' : '#69b1ff'),
        errorForeground: colors.errorForeground || (isLight ? '#e51400' : '#ff6762'),
    };

    for (const [key, fallbackVal] of Object.entries(defaultColorMappings)) {
        if (!colors[key]) {
            const varName = `--vscode-${key.replace(/\./g, '-')}`;
            rules.push(`  ${varName}: ${fallbackVal};`);
        }
    }

    // Ensure lanes have vivid colors derived from git decoration / ansi / charts
    const green = colors['gitDecoration.addedResourceForeground'] || colors['terminal.ansiGreen'] || '#60d199';
    const blue = colors['gitDecoration.modifiedResourceForeground'] || colors['terminal.ansiBlue'] || '#69b1ff';
    const red = colors['gitDecoration.deletedResourceForeground'] || colors['terminal.ansiRed'] || '#ff6762';
    const purple = colors['gitDecoration.conflictingResourceForeground'] || colors['terminal.ansiMagenta'] || '#9d6afb';
    const yellow = colors['terminal.ansiYellow'] || '#ffd452';
    const orange = colors['terminal.ansiBrightYellow'] || '#ffab16';
    const cyan = colors['terminal.ansiCyan'] || '#68cdf2';

    rules.push(`  --jj-lane-0: ${green};`);
    rules.push(`  --jj-lane-1: ${blue};`);
    rules.push(`  --jj-lane-2: ${yellow};`);
    rules.push(`  --jj-lane-3: ${purple};`);
    rules.push(`  --jj-lane-4: ${orange};`);
    rules.push(`  --jj-lane-5: ${red};`);
    rules.push(`  --jj-lane-6: ${cyan};`);

    let styleEl = document.getElementById('jj-view-dynamic-theme') as HTMLStyleElement | null;
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'jj-view-dynamic-theme';
        document.head.appendChild(styleEl);
    }

    styleEl.textContent = `:root, body.vscode-dark, body.vscode-light {\n${rules.join('\n')}\n}`;
}
