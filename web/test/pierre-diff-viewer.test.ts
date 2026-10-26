/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import {
    formatByteSize,
    getDataUrlByteLength,
    getImageMimeType,
    isBinaryBuffer,
    isBinaryByExtension,
    isBinaryFile,
    isBinaryString,
    isImageByExtension,
    isSvgByExtension,
    uint8ArrayToDataUrl,
} from '../src/diff/binary-detection';
import { ensureHighlighterRegistered } from '../src/diff/highlighter-setup';
import ImageDiffViewer from '../src/diff/ImageDiffViewer.svelte';
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

    it('detects image files and computes data URLs and byte sizes accurately', () => {
        expect(isImageByExtension('icon.png')).toBe(true);
        expect(isImageByExtension('photo.jpeg (abcd1234)')).toBe(true);
        expect(isImageByExtension('hero.webp')).toBe(true);
        expect(isImageByExtension('archive.zip')).toBe(false);
        expect(isImageByExtension('vector.svg')).toBe(false);
        expect(isSvgByExtension('vector.svg (12345678)')).toBe(true);
        expect(getImageMimeType('logo.png')).toBe('image/png');
        expect(getImageMimeType('archive.zip')).toBeUndefined();

        const rawBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const dataUrl = uint8ArrayToDataUrl(rawBytes, 'image/png');
        expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
        expect(getDataUrlByteLength(dataUrl)).toBe(8);
        expect(uint8ArrayToDataUrl(new Uint8Array(0), 'image/png')).toBe('');
        expect(getDataUrlByteLength('')).toBe(0);

        expect(formatByteSize(512)).toBe('512 B');
        expect(formatByteSize(2048)).toBe('2.0 KB');
        expect(formatByteSize(2 * 1024 * 1024)).toBe('2.00 MB');
    });
});

describe('PierreDiffViewer Component', () => {
    it('renders binary suppression card when file is a non-image binary', () => {
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'archive.zip',
                originalContent: '',
                modifiedContent: 'PK\x03\x04\x00_BINARY_DATA',
                isWorkingCopy: true,
            },
        });
        const html = result.body;

        expect(html).toContain('binary-diff-card');
        expect(html).toContain('Binary file not shown');
        expect(html).toContain('archive.zip');
        expect(html).toContain('The file cannot be displayed in the text diff viewer.');
    });

    it('renders ImageDiffViewer when file is an image', () => {
        const samplePng = uint8ArrayToDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
        const updatedPng = uint8ArrayToDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]), 'image/png');
        const result = render(PierreDiffViewer, {
            props: {
                filename: 'icon.png',
                originalContent: samplePng,
                modifiedContent: updatedPng,
                isWorkingCopy: true,
            },
        });
        const html = result.body;

        expect(html).toContain('image-diff-viewer');
        expect(html).toContain('image-pane-before');
        expect(html).toContain('image-pane-after');
        expect(html).toContain('image-diff-mode-2up');
        expect(html).toContain('image-diff-mode-swipe');
        expect(html).toContain('image-diff-mode-onion');
        expect(html).toContain('image-diff-mode-difference');
        expect(html).toContain('+2 B (+50.0%)');
        expect(html).not.toContain('binary-diff-card');
    });

    it('renders single Added card in ImageDiffViewer when original is empty', () => {
        const addedPng = uint8ArrayToDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
        const result = render(ImageDiffViewer, {
            props: {
                filename: 'new-banner.png',
                originalContent: '',
                modifiedContent: addedPng,
                fileStatus: 'added',
            },
        });
        const html = result.body;

        expect(html).toContain('image-diff-viewer');
        expect(html).toContain('Added');
        expect(html).toContain('image-pane-after');
        expect(html).not.toContain('image-pane-before');
        expect(html).not.toContain('image-diff-mode-swipe');
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
        expect(html).not.toContain('diff-toolbar');
        expect(html).toContain('toggle-split-diff');
        expect(html).toContain('toggle-unified-diff');
        expect(html).toContain('diff-content-container');
    });

    it('does not render toolbar buttons even when isWorkingCopy is true', () => {
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

        expect(html).not.toContain('diff-undo-btn');
        expect(html).not.toContain('diff-redo-btn');
        expect(html).not.toContain('diff-save-btn');
        expect(html).not.toContain('diff-discard-btn');
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
