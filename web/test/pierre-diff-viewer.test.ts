/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { isBinaryBuffer, isBinaryByExtension, isBinaryFile, isBinaryString } from '../src/diff/binary-detection';
import { ensureHighlighterRegistered } from '../src/diff/highlighter-setup';
import PierreDiffViewer from '../src/diff/PierreDiffViewer.svelte';

describe('Binary Detection Utilities', () => {
    it('detects binary files by extension', () => {
        expect(isBinaryByExtension('image.png')).toBe(true);
        expect(isBinaryByExtension('archive.zip')).toBe(true);
        expect(isBinaryByExtension('module.wasm')).toBe(true);
        expect(isBinaryByExtension('binary.exe')).toBe(true);
        expect(isBinaryByExtension('font.woff2')).toBe(true);
        expect(isBinaryByExtension('nested/path/to/image.png')).toBe(true);
        expect(isBinaryByExtension('dir.with.dot/image.png')).toBe(true);

        expect(isBinaryByExtension('code.ts')).toBe(false);
        expect(isBinaryByExtension('component.svelte')).toBe(false);
        expect(isBinaryByExtension('daemon.go')).toBe(false);
        expect(isBinaryByExtension('config.json')).toBe(false);
        expect(isBinaryByExtension('README.md')).toBe(false);
        expect(isBinaryByExtension('no_extension')).toBe(false);
        // Path with dot in directory name but extensionless file
        expect(isBinaryByExtension('dir.with.dot/extensionless_file')).toBe(false);
        expect(isBinaryByExtension('dir.png/extensionless_file')).toBe(false);
    });

    it('detects binary files by string null-byte check', () => {
        const textContent = 'function hello() {\n    return "world";\n}\n';
        expect(isBinaryString(textContent)).toBe(false);

        const binaryContent = 'GIF89a\x01\x00\x01\x00\x80\x00\x00';
        expect(isBinaryString(binaryContent)).toBe(true);
    });

    it('detects binary files by buffer null-byte check', () => {
        const uint8Text = new TextEncoder().encode('Hello world from Uint8Array');
        expect(isBinaryBuffer(uint8Text)).toBe(false);

        const uint8Binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x01]);
        expect(isBinaryBuffer(uint8Binary)).toBe(true);
    });

    it('combines extension and content checks in isBinaryFile', () => {
        expect(isBinaryFile('photo.jpg')).toBe(true);
        expect(isBinaryFile('clean.txt', 'Just plain text')).toBe(false);
        expect(isBinaryFile('sneaky.txt', 'Text with null \x00 byte')).toBe(true);
        expect(isBinaryFile('folder.with.dot/clean.txt', 'Normal text')).toBe(false);
    });
});

describe('PierreDiffViewer Component', () => {
    it('renders binary suppression card when file is binary', () => {
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'icon.png',
                originalContent: '',
                modifiedContent: 'PNG_DATA_WITH_\x00_BYTE',
                isWorkingCopy: true,
            },
        });
        const html = result.body;

        expect(html).toContain('binary-diff-card');
        expect(html).toContain('Binary file not shown');
        expect(html).toContain('icon.png');
        expect(html).toContain('The file cannot be displayed in the text diff viewer.');
    });

    it('renders text diff viewer and toolbar for text files', () => {
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'src/main.ts',
                originalContent: 'const a = 1;',
                modifiedContent: 'const a = 2;',
                isWorkingCopy: false,
                isConflict: false,
            },
        });
        const html = result.body;

        expect(html).toContain('pierre-diff-viewer');
        expect(html).toContain('diff-toolbar');
        expect(html).toContain('src/main.ts');
        expect(html).toContain('toggle-split-diff');
        expect(html).toContain('toggle-unified-diff');
        expect(html).toContain('diff-content-container');
    });

    it('renders edit toolbar actions when isWorkingCopy is true', () => {
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'src/editable.ts',
                originalContent: 'line 1',
                modifiedContent: 'line 1 edited',
                isWorkingCopy: true,
                onSave: vi.fn(),
                onDiscard: vi.fn(),
            },
        });
        const html = result.body;

        expect(html).toContain('diff-undo-btn');
        expect(html).toContain('diff-redo-btn');
        expect(html).toContain('diff-save-btn');
        expect(html).toContain('diff-discard-btn');
    });

    it('renders resolve conflict button when isConflict is true', () => {
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'conflict.ts',
                originalContent: 'base line',
                modifiedContent: '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>>',
                isWorkingCopy: true,
                isConflict: true,
                onResolveConflict: vi.fn(),
            },
        });
        const html = result.body;

        expect(html).toContain('diff-resolve-conflict-btn');
        expect(html).toContain('Mark Resolved');
    });

    it('renders cleanly for added files without errors', () => {
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'src/new-file.ts',
                originalContent: '',
                modifiedContent: 'export const hello = "world";\n',
                fileStatus: 'added',
                isWorkingCopy: true,
            },
        });
        const html = result.body;
        expect(html).toContain('pierre-diff-viewer');
        expect(html).toContain('src/new-file.ts');
        expect(html).toContain('diff-content-container');
    });

    it('renders cleanly for deleted files without errors', () => {
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'src/old-file.ts',
                originalContent: 'export const old = true;\n',
                modifiedContent: '',
                fileStatus: 'deleted',
                isWorkingCopy: true,
            },
        });
        const html = result.body;
        expect(html).toContain('pierre-diff-viewer');
        expect(html).toContain('src/old-file.ts');
        expect(html).toContain('diff-content-container');
    });

    it('registers custom languages and themes without error', () => {
        expect(() => {
            ensureHighlighterRegistered();
        }).not.toThrow();
    });
});
