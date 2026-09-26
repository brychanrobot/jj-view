/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerCustomLanguage, registerCustomTheme } from '@pierre/diffs';
import pierreDarkRaw from '@pierre/theme/pierre-dark';
import pierreDarkProtanopiaDeuteranopiaRaw from '@pierre/theme/pierre-dark-protanopia-deuteranopia';
import pierreDarkSoftRaw from '@pierre/theme/pierre-dark-soft';
import pierreDarkTritanopiaRaw from '@pierre/theme/pierre-dark-tritanopia';
import pierreDarkVibrantRaw from '@pierre/theme/pierre-dark-vibrant';
import pierreLightRaw from '@pierre/theme/pierre-light';
import pierreLightProtanopiaDeuteranopiaRaw from '@pierre/theme/pierre-light-protanopia-deuteranopia';
import pierreLightSoftRaw from '@pierre/theme/pierre-light-soft';
import pierreLightTritanopiaRaw from '@pierre/theme/pierre-light-tritanopia';
import pierreLightVibrantRaw from '@pierre/theme/pierre-light-vibrant';
import { normalizeTheme, type ThemeRegistration } from 'shiki';

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

const PIERRE_RAW_THEMES: Record<string, RawPierreTheme> = {
    'pierre-dark': pierreDarkRaw,
    'pierre-dark-soft': pierreDarkSoftRaw,
    'pierre-dark-vibrant': pierreDarkVibrantRaw,
    'pierre-dark-protanopia-deuteranopia': pierreDarkProtanopiaDeuteranopiaRaw,
    'pierre-dark-tritanopia': pierreDarkTritanopiaRaw,
    'pierre-light': pierreLightRaw,
    'pierre-light-soft': pierreLightSoftRaw,
    'pierre-light-vibrant': pierreLightVibrantRaw,
    'pierre-light-protanopia-deuteranopia': pierreLightProtanopiaDeuteranopiaRaw,
    'pierre-light-tritanopia': pierreLightTritanopiaRaw,
};

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
 * Pre-registers bundled Shiki language grammars, all 10 Pierre themes, and Shiki themes with @pierre/diffs
 * so they are bundled into the web distribution and resolve synchronously/locally
 * without unbundled runtime HTTP dynamic imports.
 */
interface ThemeWindow extends Window {
    __jjRegisteredThemes?: Set<string>;
    __jjRegisteredLanguages?: Set<string>;
}

export function ensureHighlighterRegistered(): void {
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

    // Normalize all Pierre Themes for application CSS theming.
    // Note: Do NOT call registerCustomTheme for Pierre themes because @pierre/diffs already has them registered built-in.
    for (const [name, raw] of Object.entries(PIERRE_RAW_THEMES)) {
        const normalized = normalizeTheme(toThemeRegistration(raw));
        normalizedPierreThemes.set(name, normalized);
    }

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
    registerLangOnce('json', () => import('@shikijs/langs/json'), ['json']);
    registerLangOnce('jsonc', () => import('@shikijs/langs/jsonc'), ['jsonc']);
    registerLangOnce('go', () => import('@shikijs/langs/go'), ['go']);
    registerLangOnce('rust', () => import('@shikijs/langs/rust'), ['rs']);
    registerLangOnce('python', () => import('@shikijs/langs/python'), ['py']);
    registerLangOnce('html', () => import('@shikijs/langs/html'), ['html', 'htm']);
    registerLangOnce('css', () => import('@shikijs/langs/css'), ['css']);
    registerLangOnce('markdown', () => import('@shikijs/langs/markdown'), ['md', 'markdown']);
    registerLangOnce('yaml', () => import('@shikijs/langs/yaml'), ['yaml', 'yml']);
    registerLangOnce('toml', () => import('@shikijs/langs/toml'), ['toml']);
    registerLangOnce('shellscript', () => import('@shikijs/langs/shellscript'), ['sh', 'bash', 'zsh']);
    registerLangOnce('diff', () => import('@shikijs/langs/diff'), ['diff', 'patch']);
    registerLangOnce('c', () => import('@shikijs/langs/c'), ['c', 'h']);
    registerLangOnce('cpp', () => import('@shikijs/langs/cpp'), ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx']);
    registerLangOnce('csharp', () => import('@shikijs/langs/csharp'), ['cs']);
    registerLangOnce('java', () => import('@shikijs/langs/java'), ['java']);
    registerLangOnce('dockerfile', () => import('@shikijs/langs/dockerfile'), ['dockerfile', 'Dockerfile']);
    registerLangOnce('xml', () => import('@shikijs/langs/xml'), ['xml', 'svg']);
    registerLangOnce('sql', () => import('@shikijs/langs/sql'), ['sql']);
}

/**
 * Loads a ThemeRegistration by name, resolving Pierre or Shiki themes.
 */
export async function loadTheme(name: string): Promise<ThemeRegistration> {
    ensureHighlighterRegistered();

    const pierre = normalizedPierreThemes.get(name);
    if (pierre) {
        return pierre;
    }

    const cachedShiki = normalizedShikiThemes.get(name);
    if (cachedShiki) {
        return cachedShiki;
    }

    const loader = SHIKI_THEME_LOADERS[name];
    if (loader) {
        try {
            const mod = await loader();
            const normalized = normalizeTheme(mod.default);
            normalizedShikiThemes.set(name, normalized);
            return normalized;
        } catch (err) {
            console.warn(`Dynamic load of theme "${name}" failed, retrying...`, err);
            try {
                await new Promise((resolve) => setTimeout(resolve, 150));
                const mod = await loader();
                const normalized = normalizeTheme(mod.default);
                normalizedShikiThemes.set(name, normalized);
                return normalized;
            } catch (retryErr) {
                console.error(`Failed to load theme "${name}":`, retryErr);
            }
        }
    }

    const fallback = normalizedPierreThemes.get('pierre-dark-soft');
    if (fallback) {
        return fallback;
    }

    return normalizeTheme(toThemeRegistration(pierreDarkSoftRaw));
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
