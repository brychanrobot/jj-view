/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PierreFileViewer from '../src/diff/PierreFileViewer.svelte';

describe('PierreFileViewer Component', () => {
    it('renders binary suppression card when file is a non-image binary', () => {
        const result = render(PierreFileViewer, {
            props: {
                filename: 'archive.zip',
                content: 'ZIP_DATA_WITH_\x00_BYTE',
                isWorkingCopy: true,
            },
        });
        const html = result.body;

        expect(html).toContain('binary-file-card');
        expect(html).toContain('Binary file not shown');
        expect(html).toContain('archive.zip');
        expect(html).toContain('The file cannot be displayed in the text editor.');
    });

    it('renders image preview when file is an image', () => {
        const result = render(PierreFileViewer, {
            props: {
                filename: 'icon.png',
                content: 'data:image/png;base64,iVBORw0KGgo=',
                isWorkingCopy: true,
            },
        });
        const html = result.body;

        expect(html).toContain('image-file-viewer');
        expect(html).toContain('image-pane-single');
        expect(html).not.toContain('binary-file-card');
    });

    it('renders text file viewer container without diff toggles or redundant header toolbar', () => {
        const result = render(PierreFileViewer, {
            props: {
                filename: 'src/main.ts',
                content: 'const a = 1;\nconsole.log(a);\n',
                isWorkingCopy: false,
            },
        });
        const html = result.body;

        expect(html).toContain('pierre-file-viewer');
        expect(html).toContain('file-content-container');
        expect(html).not.toContain('file-toolbar');
        expect(html).not.toContain('toggle-split-diff');
        expect(html).not.toContain('toggle-unified-diff');
    });

    it('does not render toolbar buttons even when isWorkingCopy is true', () => {
        const result = render(PierreFileViewer, {
            props: {
                filename: 'src/editable.ts',
                content: 'export const value = 42;\n',
                isWorkingCopy: true,
            },
        });
        const html = result.body;

        expect(html).toContain('pierre-file-viewer');
        expect(html).not.toContain('file-toolbar');
        expect(html).not.toContain('file-undo-btn');
        expect(html).not.toContain('file-redo-btn');
        expect(html).not.toContain('file-save-btn');
        expect(html).not.toContain('file-discard-btn');
    });
});
