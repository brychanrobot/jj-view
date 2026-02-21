/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';

import { createDiffUris } from '../uri-utils';
import { JjStatusEntry } from '../jj-types';


// Mock vscode
vi.mock('vscode', async () => {
    // await import('./vscode-mock'); // this was redundant
    const { createVscodeMock } = await import('./vscode-mock');
    return await createVscodeMock({});
});

describe('createDiffUris', () => {
    const root = '/root';

    it('creates correct URIs for modified file', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        const revision = 'rev1';
        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.path).toBe('/root/file.txt');
        expect(leftUri.query).toContain('base=rev1');
        expect(leftUri.query).toContain('side=left');

        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.path).toBe('/root/file.txt');
        expect(rightUri.query).toContain('base=rev1');
        expect(rightUri.query).toContain('side=right');
    });

    it('creates correct URIs for working copy (rev=@)', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        const revision = '@';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.path).toBe('/root/file.txt');
        expect(leftUri.query).toContain('base=@');
        expect(leftUri.query).toContain('side=left');

        // Working copy should use file scheme for right side
        expect(rightUri.scheme).toBe('file');
        expect(rightUri.path).toBe('/root/file.txt');
    });

    it('handles renamed files correctly', () => {
        const entry: JjStatusEntry = {
            path: 'new.txt',
            oldPath: 'old.txt',
            status: 'renamed',
        };
        const revision = 'rev1';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        // Left side should use old path
        expect(leftUri.path).toBe('/root/old.txt');
        expect(leftUri.query).toContain('base=rev1');
        expect(leftUri.query).toContain('side=left');
        
        // Right side should use new path
        expect(rightUri.path).toBe('/root/new.txt');
        expect(rightUri.query).toContain('base=rev1');
        expect(rightUri.query).toContain('side=right');
    });
});
