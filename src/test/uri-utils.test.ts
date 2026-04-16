/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { JjStatusEntry } from '../jj-types';
import { createDiffUris } from '../uri-utils';

// Mock vscode
vi.mock('vscode', async () => {
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

    it('handles removed files in working copy correctly', () => {
        const entry: JjStatusEntry = {
            path: 'deleted.txt',
            status: 'removed',
        };
        const revision = '@';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.path).toBe('/root/deleted.txt');
        expect(leftUri.query).toContain('base=@');
        expect(leftUri.query).toContain('side=left');

        // DESIRED FIX: Removed files in working copy should use jj-view scheme for right side
        // to avoid "File not found" errors in VS Code.
        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.path).toBe('/root/deleted.txt');
        expect(rightUri.query).toContain('base=@');
        expect(rightUri.query).toContain('side=right');
    });

    it('handles deleted status in working copy correctly', () => {
        const entry: JjStatusEntry = {
            path: 'deleted.txt',
            status: 'deleted',
        };
        const revision = '@';

        const { rightUri } = createDiffUris(entry, revision, root);

        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.query).toContain('side=right');
    });

    it('handles removed files in ancestors correctly', () => {
        const entry: JjStatusEntry = {
            path: 'deleted.txt',
            status: 'removed',
        };
        const revision = 'rev1';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.query).toContain('side=right');
    });

    it('handles added files in working copy correctly', () => {
        const entry: JjStatusEntry = {
            path: 'new.txt',
            status: 'added',
        };
        const revision = '@';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.query).toContain('side=left');
        expect(rightUri.scheme).toBe('file');
    });

    it('handles copied files correctly', () => {
        const entry: JjStatusEntry = {
            path: 'copy.txt',
            oldPath: 'original.txt',
            status: 'copied',
        };
        const revision = 'rev1';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.path).toBe('/root/original.txt');
        expect(rightUri.path).toBe('/root/copy.txt');
    });

    it('detects working copy via options.workingCopyChangeId', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        // Revision is a commit ID, but it matches the working copy change ID
        const revision = 'commit-123';
        const { rightUri } = createDiffUris(entry, revision, root, {
            workingCopyChangeId: 'commit-123',
        });

        expect(rightUri.scheme).toBe('file');
    });
});
