/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { applyAppTheme, isLightTheme, loadTheme } from '../src/diff/highlighter-setup';

interface FakeElement {
    id: string;
    textContent: string;
    tagName: string;
}

interface FakeDocument {
    body: {
        classList: {
            add: (cls: string) => void;
            remove: (cls: string) => void;
            contains: (cls: string) => boolean;
        };
    };
    documentElement: {
        setAttribute: (name: string, val: string) => void;
        getAttribute: (name: string) => string | null;
    };
    getElementById: (id: string) => FakeElement | null;
    createElement: (tag: string) => FakeElement;
    head: {
        appendChild: (el: FakeElement) => FakeElement;
    };
}

describe('Highlighter and Theming Setup', () => {
    it('correctly identifies light vs dark themes', () => {
        expect(isLightTheme('pierre-light')).toBe(true);
        expect(isLightTheme('pierre-light-soft')).toBe(true);
        expect(isLightTheme('github-light')).toBe(true);
        expect(isLightTheme('catppuccin-latte')).toBe(true);
        expect(isLightTheme('rose-pine-dawn')).toBe(true);
        expect(isLightTheme('light-plus')).toBe(true);

        expect(isLightTheme('pierre-dark')).toBe(false);
        expect(isLightTheme('pierre-dark-soft')).toBe(false);
        expect(isLightTheme('catppuccin-mocha')).toBe(false);
        expect(isLightTheme('dracula')).toBe(false);
        expect(isLightTheme('nord')).toBe(false);
        expect(isLightTheme('tokyo-night')).toBe(false);
    });

    it('loads Pierre themes with valid colors', async () => {
        const theme = await loadTheme('pierre-dark-soft');
        expect(theme.name).toBe('pierre-dark-soft');
        expect(theme.type).toBe('dark');
        expect(theme.colors).toBeDefined();
        expect(theme.colors?.['editor.background']).toBeDefined();
    });

    it('loads Shiki themes dynamically with valid colors', async () => {
        const theme = await loadTheme('catppuccin-mocha');
        expect(theme.name).toBe('catppuccin-mocha');
        expect(theme.colors).toBeDefined();
        expect(theme.colors?.['editor.background']).toBeDefined();
        expect(theme.colors?.['sideBar.background']).toBeDefined();
    });

    it('falls back to default Pierre theme for unknown themes', async () => {
        const theme = await loadTheme('non-existent-theme-xyz');
        expect(theme.name).toBe('pierre-dark-soft');
        expect(theme.colors).toBeDefined();
    });

    it('applies theme to document, toggles body class, and injects CSS custom properties', async () => {
        const classList = new Set<string>();
        const attributes = new Map<string, string>();
        let injectedStyle: FakeElement | null = null;

        const fakeDoc: FakeDocument = {
            body: {
                classList: {
                    add: (cls: string) => {
                        classList.add(cls);
                    },
                    remove: (cls: string) => {
                        classList.delete(cls);
                    },
                    contains: (cls: string) => classList.has(cls),
                },
            },
            documentElement: {
                setAttribute: (name: string, val: string) => {
                    attributes.set(name, val);
                },
                getAttribute: (name: string) => attributes.get(name) ?? null,
            },
            getElementById: (id: string) => (injectedStyle?.id === id ? injectedStyle : null),
            createElement: (tag: string) => ({ id: '', textContent: '', tagName: tag }),
            head: {
                appendChild: (el: FakeElement) => {
                    injectedStyle = el;
                    return el;
                },
            },
        };

        const targetGlobal = globalThis as { document?: FakeDocument };
        targetGlobal.document = fakeDoc;

        try {
            const theme = await loadTheme('github-dark');
            applyAppTheme(theme);

            expect(classList.has('vscode-dark')).toBe(true);
            expect(classList.has('vscode-light')).toBe(false);
            expect(attributes.get('data-theme')).toBe('github-dark');

            expect(injectedStyle).not.toBeNull();
            const css = injectedStyle ? (injectedStyle as FakeElement).textContent : '';
            expect(css).toContain('--vscode-editor-background:');
            expect(css).toContain('--vscode-sideBar-background:');
            expect(css).toContain('--jj-lane-0:');

            // Test light theme application
            const lightTheme = await loadTheme('github-light');
            applyAppTheme(lightTheme);

            expect(classList.has('vscode-light')).toBe(true);
            expect(classList.has('vscode-dark')).toBe(false);
            expect(attributes.get('data-theme')).toBe('github-light');
        } finally {
            delete targetGlobal.document;
        }
    });

    it('loads various dark and light Shiki themes without error', async () => {
        const themesToTest = [
            'dracula',
            'tokyo-night',
            'one-dark-pro',
            'night-owl',
            'solarized-light',
            'catppuccin-latte',
        ];
        for (const name of themesToTest) {
            const theme = await loadTheme(name);
            expect(theme.name).toBe(name);
            expect(theme.colors).toBeDefined();
        }
    });
});
