/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PierreMultiDiffViewer from '../src/diff/PierreMultiDiffViewer.svelte';

describe('PierreMultiDiffViewer Component', () => {
    it('renders multi-diff viewer with floating toggle for single file', () => {
        const result = render(PierreMultiDiffViewer, {
            props: {
                title: 'Review Single Change',
                files: [
                    {
                        filename: 'src/file1.ts',
                        originalContent: 'const a = 1;',
                        modifiedContent: 'const a = 2;',
                    },
                ],
            },
        });
        const html = result.body;

        expect(html).toContain('pierre-multi-diff-viewer');
        expect(html).not.toContain('multi-diff-toolbar');
        expect(html).toContain('toggle-split-diff');
        expect(html).toContain('toggle-unified-diff');
        expect(html).toContain('multi-diff-content-container');
    });

    it('renders multi-diff viewer with floating toggle for multiple files', () => {
        const result = render(PierreMultiDiffViewer, {
            props: {
                title: 'Working Copy Changes',
                files: [
                    {
                        filename: 'feature-a.txt',
                        originalContent: 'original a',
                        modifiedContent: 'modified a',
                    },
                    {
                        filename: 'feature-b.txt',
                        originalContent: 'original b',
                        modifiedContent: 'modified b',
                    },
                    {
                        filename: 'feature-c.txt',
                        originalContent: '',
                        modifiedContent: 'new c',
                        fileStatus: 'added',
                    },
                ],
            },
        });
        const html = result.body;

        expect(html).toContain('pierre-multi-diff-viewer');
        expect(html).not.toContain('multi-diff-toolbar');
        expect(html).toContain('toggle-split-diff');
        expect(html).toContain('toggle-unified-diff');
        expect(html).toContain('multi-diff-content-container');
    });

    it('renders empty multi-diff viewer gracefully when files array is empty', () => {
        const result = render(PierreMultiDiffViewer, {
            props: {
                title: 'Empty Changes',
                files: [],
            },
        });
        const html = result.body;

        expect(html).toContain('pierre-multi-diff-viewer');
        expect(html).not.toContain('multi-diff-toolbar');
    });
});
