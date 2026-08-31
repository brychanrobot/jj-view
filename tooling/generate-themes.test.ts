/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { generateThemes, resolveColor, type ThemeJsonConfig } from './generate-themes';

describe('resolveColor', () => {
    it('should resolve --opaque(var(--variable)) to relative color syntax', () => {
        expect(resolveColor('--opaque(var(--vscode-charts-orange))')).toBe(
            'rgb(from var(--vscode-charts-orange) r g b / 1)',
        );
    });

    it('should resolve --opaque with whitespace', () => {
        expect(resolveColor('  --opaque(var(--vscode-charts-blue))  ')).toBe(
            'rgb(from var(--vscode-charts-blue) r g b / 1)',
        );
    });

    it('should leave regular colors unchanged', () => {
        expect(resolveColor('#ff0000')).toBe('#ff0000');
        expect(resolveColor('var(--vscode-charts-green)')).toBe('var(--vscode-charts-green)');
    });
});

describe('generateThemes', () => {
    it('should generate valid TS and CSS output for a cycle theme', () => {
        const mockData: Record<string, ThemeJsonConfig> = {
            'test-cycle': {
                strategy: 'cycle',
                colors: ['#facade', '#defaced'],
            },
        };

        const { ts, css } = generateThemes(mockData);

        // Verify TS output
        expect(ts).toContain(`'test-cycle': {`);
        expect(ts).toContain(`strategy: 'cycle',`);
        expect(ts).toContain(`count: 2`);

        // Verify CSS output
        expect(css).toContain(`.theme-test-cycle {`);
        expect(css).toContain(`--jj-lane-0: #facade;`);
        expect(css).toContain(`--jj-lane-1: #defaced;`);
        expect(css).not.toContain(`.vscode-light`);
    });

    it('should generate valid TS and CSS output with light colors', () => {
        const mockData: Record<string, ThemeJsonConfig> = {
            'test-clamp': {
                strategy: 'clamp',
                colors: ['#000000', '#111111'],
                lightColors: ['#ffffff', '#eeeeee'],
            },
        };

        const { ts, css } = generateThemes(mockData);

        // Verify TS output
        expect(ts).toContain(`'test-clamp': {`);
        expect(ts).toContain(`strategy: 'clamp',`);
        expect(ts).toContain(`count: 2`);

        // Verify CSS output
        expect(css).toContain(`.theme-test-clamp {`);
        expect(css).toContain(`--jj-lane-0: #000000;`);
        expect(css).toContain(`--jj-lane-1: #111111;`);

        // Verify light theme output
        expect(css).toContain(`.vscode-light .theme-test-clamp {`);
        expect(css).toContain(`--jj-lane-0: #ffffff;`);
        expect(css).toContain(`--jj-lane-1: #eeeeee;`);
    });

    it('should polyfill --opaque() expressions in colors and lightColors', () => {
        const mockData: Record<string, ThemeJsonConfig> = {
            'test-opaque': {
                strategy: 'cycle',
                colors: ['var(--vscode-charts-green)', '--opaque(var(--vscode-charts-orange))'],
                lightColors: ['--opaque(var(--vscode-charts-yellow))'],
            },
        };

        const { ts, css } = generateThemes(mockData);

        // Verify TS output preserves count
        expect(ts).toContain(`'test-opaque': {`);
        expect(ts).toContain(`count: 2`);

        // Verify CSS output compiles --opaque() to rgb(from ... r g b / 1)
        expect(css).toContain(`.theme-test-opaque {`);
        expect(css).toContain(`--jj-lane-0: var(--vscode-charts-green);`);
        expect(css).toContain(`--jj-lane-1: rgb(from var(--vscode-charts-orange) r g b / 1);`);

        // Verify lightColors compilation
        expect(css).toContain(`.vscode-light .theme-test-opaque {`);
        expect(css).toContain(`--jj-lane-0: rgb(from var(--vscode-charts-yellow) r g b / 1);`);
    });
});
