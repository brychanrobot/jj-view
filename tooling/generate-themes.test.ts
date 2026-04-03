/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { ThemeJsonConfig, generateThemes } from './generate-themes';

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
});
