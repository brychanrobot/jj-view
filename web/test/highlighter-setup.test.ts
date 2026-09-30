/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getFiletypeFromFileName, RegisteredCustomLanguages } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import { applyAppTheme, ensureHighlighterRegistered, isLightTheme, loadTheme } from '../src/diff/highlighter-setup';

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

    it('registers svelte, vue, gn, mojom, bazel, proto, textproto, and android/flutter languages with loadable grammars', async () => {
        ensureHighlighterRegistered();

        const languages = [
            'svelte',
            'vue',
            'gn',
            'mojom',
            'bazel',
            'starlark',
            'bzl',
            'protobuf',
            'proto',
            'textproto',
            'pbtxt',
            'kotlin',
            'dart',
            'groovy',
            'properties',
            'proguard',
        ];
        for (const lang of languages) {
            expect(RegisteredCustomLanguages.has(lang)).toBe(true);
            const loader = RegisteredCustomLanguages.get(lang);
            expect(loader).toBeDefined();
            if (loader) {
                const grammar = await loader();
                expect(grammar).toBeDefined();
            }
        }
    });

    it('correctly maps file extensions and names to custom languages via getFiletypeFromFileName', () => {
        ensureHighlighterRegistered();

        expect(getFiletypeFromFileName('App.svelte')).toBe('svelte');
        expect(getFiletypeFromFileName('Component.vue')).toBe('vue');
        expect(getFiletypeFromFileName('BUILD.gn')).toBe('gn');
        expect(getFiletypeFromFileName('args.gn')).toBe('gn');
        expect(getFiletypeFromFileName('toolchain.gni')).toBe('gn');
        expect(getFiletypeFromFileName('service.mojom')).toBe('mojom');
        expect(getFiletypeFromFileName('BUILD')).toBe('bazel');
        expect(getFiletypeFromFileName('BUILD.bazel')).toBe('bazel');
        expect(getFiletypeFromFileName('WORKSPACE')).toBe('bazel');
        expect(getFiletypeFromFileName('WORKSPACE.bazel')).toBe('bazel');
        expect(getFiletypeFromFileName('MODULE.bazel')).toBe('bazel');
        expect(getFiletypeFromFileName('rules.bzl')).toBe('bazel');
        expect(getFiletypeFromFileName('defs.star')).toBe('bazel');
        expect(getFiletypeFromFileName('script.starlark')).toBe('bazel');
        expect(getFiletypeFromFileName('person.proto')).toBe('protobuf');
        expect(getFiletypeFromFileName('config.textproto')).toBe('textproto');
        expect(getFiletypeFromFileName('data.pbtxt')).toBe('textproto');

        // Android and Flutter
        expect(getFiletypeFromFileName('MainActivity.kt')).toBe('kotlin');
        expect(getFiletypeFromFileName('script.kts')).toBe('kotlin');
        expect(getFiletypeFromFileName('build.gradle.kts')).toBe('kotlin');
        expect(getFiletypeFromFileName('settings.gradle.kts')).toBe('kotlin');
        expect(getFiletypeFromFileName('main.dart')).toBe('dart');
        expect(getFiletypeFromFileName('build.gradle')).toBe('groovy');
        expect(getFiletypeFromFileName('settings.gradle')).toBe('groovy');
        expect(getFiletypeFromFileName('Script.groovy')).toBe('groovy');
        expect(getFiletypeFromFileName('gradle.properties')).toBe('properties');
        expect(getFiletypeFromFileName('local.properties')).toBe('properties');
        expect(getFiletypeFromFileName('gradle-wrapper.properties')).toBe('properties');
        expect(getFiletypeFromFileName('proguard-rules.pro')).toBe('proguard');
        expect(getFiletypeFromFileName('consumer-rules.pro')).toBe('proguard');
        expect(getFiletypeFromFileName('rules.pro')).toBe('proguard');
        expect(getFiletypeFromFileName('app_en.arb')).toBe('json');
        expect(getFiletypeFromFileName('IRemoteService.aidl')).toBe('java');
        expect(getFiletypeFromFileName('AndroidManifest.xml')).toBe('xml');
        expect(getFiletypeFromFileName('pubspec.lock')).toBe('yaml');
        expect(getFiletypeFromFileName('gradlew')).toBe('shellscript');
        expect(getFiletypeFromFileName('gradlew.bat')).toBe('bat');
    });
});
