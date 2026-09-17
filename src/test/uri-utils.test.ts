/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { JjStatusEntry } from '../core/jj-types';
import {
    clearCanonicalRootCache,
    createCommitDetailsUri,
    createDiffUris,
    createRevisionUri,
    decodeJjViewQuery,
    encodeJjViewQuery,
    getFsPathFromUri,
    getOriginalResourceUri,
    getRepoRelativePath,
    getRevisionFromUri,
    isJjScheme,
    isWorkingCopyRevision,
    parseCommitDetailsUri,
    toFileUri,
    toForwardSlash,
    Uri,
} from '../core/uri-utils';
import './vitest-utils';
import { createVscodeMock } from './vscode-mock';

// Mock vscode
vi.mock('vscode', () => createVscodeMock({}));

const ENCODED_AT = '%40';

describe('toForwardSlash', () => {
    it('replaces backslashes with forward slashes', () => {
        expect(toForwardSlash('C:\\path\\to\\file.txt')).toBe('C:/path/to/file.txt');
        expect(toForwardSlash('foo/bar/baz')).toBe('foo/bar/baz');
    });
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
        expect(leftUri.path).toBe('/file.txt');
        expect(leftUri.fragment).toContain('root=%2Froot');
        expect(leftUri.fragment).toContain('base=rev1');
        expect(leftUri.fragment).toContain('side=left');

        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.path).toBe('/file.txt');
        expect(rightUri.fragment).toContain('root=%2Froot');
        expect(rightUri.fragment).toContain('base=rev1');
        expect(rightUri.fragment).toContain('side=right');
    });

    it('creates correct URIs for working copy (rev=@)', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        const revision = '@';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.path).toBe('/file.txt');
        expect(leftUri.fragment).toContain(`base=${ENCODED_AT}`);
        expect(leftUri.fragment).toContain('side=left');

        // Working copy should use file scheme for right side
        expect(rightUri.scheme).toBe('file');
        expect(rightUri.fsPath).toBeSameFsPath('/root/file.txt');
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
        expect(leftUri.path).toBe('/old.txt');
        expect(leftUri.fragment).toContain('base=rev1');
        expect(leftUri.fragment).toContain('side=left');

        // Right side should use new path
        expect(rightUri.path).toBe('/new.txt');
        expect(rightUri.fragment).toContain('base=rev1');
        expect(rightUri.fragment).toContain('side=right');
    });

    it('handles deleted files in working copy correctly', () => {
        const entry: JjStatusEntry = {
            path: 'deleted.txt',
            status: 'deleted',
        };
        const revision = '@';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.path).toBe('/deleted.txt');
        expect(leftUri.fragment).toContain(`base=${ENCODED_AT}`);
        expect(leftUri.fragment).toContain('side=left');

        // Removed files in working copy should use jj-view scheme for right side
        // to avoid "File not found" errors in VS Code.
        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.path).toBe('/deleted.txt');
        expect(rightUri.fragment).toContain(`base=${ENCODED_AT}`);
        expect(rightUri.fragment).toContain('side=right');
    });

    it('handles deleted files in ancestors correctly', () => {
        const entry: JjStatusEntry = {
            path: 'deleted.txt',
            status: 'deleted',
        };
        const revision = 'rev1';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.fragment).toContain('side=right');
    });

    it('handles added files in working copy correctly', () => {
        const entry: JjStatusEntry = {
            path: 'new.txt',
            status: 'added',
        };
        const revision = '@';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.fragment).toContain('side=left');
        expect(rightUri.scheme).toBe('file');
        expect(rightUri.fsPath).toBeSameFsPath('/root/new.txt');
    });

    it('handles copied files correctly', () => {
        const entry: JjStatusEntry = {
            path: 'copy.txt',
            oldPath: 'original.txt',
            status: 'copied',
        };
        const revision = 'rev1';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.path).toBe('/original.txt');
        expect(rightUri.path).toBe('/copy.txt');
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
        expect(rightUri.fsPath).toBeSameFsPath('/root/file.txt');
    });

    it('uses jj-edit scheme for editable ancestor commits', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        const revision = 'rev1';
        const { rightUri } = createDiffUris(entry, revision, root, { editable: true });

        expect(rightUri.scheme).toBe('jj-edit');
        expect(rightUri.path).toBe('/file.txt');
        expect(rightUri.fragment).toContain('root=%2Froot');
        expect(rightUri.fragment).toContain('revision=rev1');
    });

    it('matches working copy change ID by prefix for short change IDs', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        const shortChangeId = 'kkm';
        const fullWorkingCopyChangeId = 'kkmppszqvrqunzzuvwxtqymvtnqswmpy';
        const { rightUri } = createDiffUris(entry, shortChangeId, root, {
            workingCopyChangeId: fullWorkingCopyChangeId,
        });

        expect(rightUri.scheme).toBe('file');
        expect(rightUri.fsPath).toBeSameFsPath('/root/file.txt');
    });
});

describe('isWorkingCopyRevision', () => {
    it('returns true when revision is @', () => {
        expect(isWorkingCopyRevision('@')).toBe(true);
        expect(isWorkingCopyRevision('@', 'wc-123')).toBe(true);
    });

    it('returns false when revision or workingCopyChangeId is missing', () => {
        expect(isWorkingCopyRevision('', 'wc-123')).toBe(false);
        expect(isWorkingCopyRevision('rev-123')).toBe(false);
        expect(isWorkingCopyRevision('rev-123', undefined)).toBe(false);
    });

    it('returns true when revision exactly matches workingCopyChangeId', () => {
        expect(isWorkingCopyRevision('wc-123', 'wc-123')).toBe(true);
    });

    it('returns true when revision is a short prefix of workingCopyChangeId', () => {
        expect(isWorkingCopyRevision('kkm', 'kkmppszqvrqunzzuvwxtqymvtnqswmpy')).toBe(true);
        expect(isWorkingCopyRevision('kkmppszq', 'kkmppszqvrqunzzuvwxtqymvtnqswmpy')).toBe(true);
    });

    it('returns false when revision does not match workingCopyChangeId', () => {
        expect(isWorkingCopyRevision('other-123', 'wc-123')).toBe(false);
        expect(isWorkingCopyRevision('abc', 'kkmppszqvrqunzzuvwxtqymvtnqswmpy')).toBe(false);
    });
});

describe('createRevisionUri', () => {
    const root = '/workspace/repo';

    it('creates relative path URI with fragment root from absolute path', () => {
        const uri = createRevisionUri(root, '/workspace/repo/src/sub/file.ts', 'main');
        expect(uri.scheme).toBe('jj-view');
        expect(uri.path).toBe('/src/sub/file.ts');
        expect(uri.fragment).toContain('root=%2Fworkspace%2Frepo');
        expect(uri.fragment).toContain('revision=main');
    });

    it('creates relative path URI from relative path input', () => {
        const uri = createRevisionUri(root, 'src/sub/file.ts', 'main');
        expect(uri.scheme).toBe('jj-view');
        expect(uri.path).toBe('/src/sub/file.ts');
        expect(uri.fragment).toContain('root=%2Fworkspace%2Frepo');
        expect(uri.fragment).toContain('revision=main');
    });

    it('handles Windows-style absolute paths and encodes root in fragment', () => {
        const windowsRoot = 'C:\\workspace\\repo';
        const windowsPath = 'C:\\workspace\\repo\\src\\sub\\file.ts';

        const uri = createRevisionUri(windowsRoot, windowsPath, 'main');

        expect(uri.scheme).toBe('jj-view');
        expect(uri.path).toBe('/src/sub/file.ts');
        expect(uri.fragment).toContain(encodeURIComponent(windowsRoot));
        expect(uri.fragment).toContain('revision=main');
    });
});

describe('getFsPathFromUri and toFileUri', () => {
    const root = '/workspace/repo';

    it('reconstructs absolute path using fragment root and relative path', () => {
        const uri = createRevisionUri(root, '/workspace/repo/src/file.ts', 'rev1');
        const fsPath = getFsPathFromUri(uri);
        expect(fsPath).toBeSameFsPath('/workspace/repo/src/file.ts');
    });

    it('converts custom scheme URI to file scheme URI using toFileUri', () => {
        const customUri = createRevisionUri(root, '/workspace/repo/src/file.ts', 'rev1');
        const fileUri = toFileUri(customUri);
        expect(fileUri.scheme).toBe('file');
        expect(fileUri.fsPath).toBeSameFsPath('/workspace/repo/src/file.ts');
    });

    it('extracts target path from path fragment parameter for jj-merge-output URIs', () => {
        const filePath = '/workspace/repo/src/conflict.txt';
        const encodedPath = encodeURIComponent(filePath);
        const mergeUri = Uri.from({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: '/src/conflict.txt',
            fragment: `path=${encodedPath}&part=base`,
        });
        const fsPath = getFsPathFromUri(mergeUri);
        expect(fsPath).toBeSameFsPath(filePath);
    });
});

describe('getRevisionFromUri', () => {
    it('returns undefined for URIs without revision parameters', () => {
        const uri = Uri.file('/path/to/file.txt');
        expect(getRevisionFromUri(uri)).toBeUndefined();
    });

    it('extracts revision from jj-revision parameter', () => {
        const uri = Uri.file('/path/to/file.txt').with({
            fragment: 'jj-revision=rev123',
        });
        expect(getRevisionFromUri(uri)).toBe('rev123');
    });

    it('extracts revision from revision parameter (jj-edit style)', () => {
        const uri = Uri.file('/path/to/file.txt').with({
            fragment: 'revision=edit-rev',
        });
        expect(getRevisionFromUri(uri)).toBe('edit-rev');
    });

    it('extracts revision from base parameter (jj-view style)', () => {
        const uri = Uri.file('/path/to/file.txt').with({
            fragment: 'base=view-rev&side=right',
        });
        expect(getRevisionFromUri(uri)).toBe('view-rev');
    });

    it('prioritizes jj-revision over others', () => {
        const uri = Uri.file('/path/to/file.txt').with({
            fragment: 'jj-revision=primary&revision=secondary&base=tertiary',
        });
        expect(getRevisionFromUri(uri)).toBe('primary');
    });

    it('prioritizes revision over base', () => {
        const uri = Uri.file('/path/to/file.txt').with({
            fragment: 'revision=secondary&base=tertiary',
        });
        expect(getRevisionFromUri(uri)).toBe('secondary');
    });

    it('returns undefined for empty fragment', () => {
        const uri = Uri.file('/path/to/file.txt').with({
            fragment: '',
        });
        expect(getRevisionFromUri(uri)).toBeUndefined();
    });

    it('strips leading # or ? from fragment/query strings', () => {
        const uri = Uri.file('/path/to/file.txt').with({
            fragment: '#jj-revision=rev123',
        });
        expect(getRevisionFromUri(uri)).toBe('rev123');
    });
});

describe('getFsPathFromUri edge cases', () => {
    it('supports repoRoot as fallback for root parameter', () => {
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/src/file.ts',
            query: 'repoRoot=%2Fworkspace%2Frepo',
        });
        expect(getFsPathFromUri(uri)).toBeSameFsPath('/workspace/repo/src/file.ts');
    });

    it('strips leading # or ? in fragment/query', () => {
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/src/file.ts',
            fragment: '#root=%2Fworkspace%2Frepo',
        });
        expect(getFsPathFromUri(uri)).toBeSameFsPath('/workspace/repo/src/file.ts');
    });

    it('returns fsPath directly when it is already under the root', () => {
        const root = '/workspace/repo';
        const fsPath = path.resolve(root, 'src/sub/file.ts');

        const fileUri = Uri.file(fsPath).with({
            scheme: 'jj-view',
            fragment: `root=${encodeURIComponent(root)}&revision=main`,
        });

        const result = getFsPathFromUri(fileUri);
        expect(result).toBeSameFsPath(fsPath);
    });

    it('handles Windows-style fsPath and performs case-insensitive comparison under root', () => {
        const root = 'C:\\Workspace\\Repo';
        const fsPath = 'c:\\workspace\\repo\\src\\sub\\file.ts';

        const uri = Uri.file(fsPath).with({
            scheme: 'jj-view',
            fragment: `root=${encodeURIComponent(root)}&revision=main`,
        });

        const result = getFsPathFromUri(uri);
        expect(result).toBeSameFsPath(fsPath);
    });
});

describe('createCommitDetailsUri and parseCommitDetailsUri', () => {
    it('creates and parses a commit details URI round-trip', () => {
        const uri = createCommitDetailsUri({
            repoRoot: '/workspace/my-repo',
            changeId: 'kkmospmw',
            title: 'Commit: kkm',
        });

        expect(uri.scheme).toBe('jj-commit');
        expect(uri.authority).toBe('commit');
        expect(uri.path).toBe('/Commit: kkm');

        const parsed = parseCommitDetailsUri(uri);
        expect(parsed.changeId).toBe('kkmospmw');
        expect(parsed.repoRoot?.fsPath).toBeSameFsPath('/workspace/my-repo');
    });

    it('gracefully handles missing parameters in parseCommitDetailsUri', () => {
        const uri = Uri.from({
            scheme: 'jj-commit',
            authority: 'commit',
            path: '/Commit: abc',
        });

        const parsed = parseCommitDetailsUri(uri);
        expect(parsed.changeId).toBe('');
        expect(parsed.repoRoot).toBeUndefined();
    });
});

describe('getFsPathFromUri boundary checks', () => {
    it('does not falsely match prefixes that do not end at path separators', () => {
        const root = '/app';
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/apple/test.ts',
            fragment: `root=${encodeURIComponent(root)}&revision=main`,
        });

        const result = getFsPathFromUri(uri);
        expect(result).toBeSameFsPath('/app/apple/test.ts');
    });

    it('handles files containing literal % in path without throwing', () => {
        const root = '/workspace/repo';
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/report_100%_done.txt',
            fragment: `root=${encodeURIComponent(root)}&revision=main`,
        });

        const result = getFsPathFromUri(uri);
        expect(result).toBeSameFsPath('/workspace/repo/report_100%_done.txt');
    });

    it('handles root with trailing slash correctly', () => {
        const root = '/workspace/repo/';
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/src/file.ts',
            fragment: `root=${encodeURIComponent(root)}&revision=main`,
        });

        const result = getFsPathFromUri(uri);
        expect(result).toBeSameFsPath('/workspace/repo/src/file.ts');
    });
});

describe('isJjScheme', () => {
    it('returns true for jj-view and jj-edit schemes', () => {
        expect(isJjScheme(Uri.parse('jj-view:///file.txt'))).toBe(true);
        expect(isJjScheme(Uri.parse('jj-edit:///file.txt'))).toBe(true);
    });

    it('returns false for file and other schemes', () => {
        expect(isJjScheme(Uri.parse('file:///file.txt'))).toBe(false);
        expect(isJjScheme(Uri.parse('https://example.com'))).toBe(false);
    });
});

describe('getOriginalResourceUri and getRepoRelativePath', () => {
    const root = '/workspace/repo';

    it('generates original resource URI with jj-view scheme for diff left side', () => {
        const fileUri = Uri.file('/workspace/repo/src/index.ts');
        const origUri = getOriginalResourceUri(root, fileUri);

        expect(origUri.scheme).toBe('jj-view');
        expect(origUri.path).toBe('/src/index.ts');
        expect(origUri.fragment).toContain('side=left');
        expect(origUri.fragment).toContain('base=%40');
    });

    it('computes repo relative path for file and custom scheme URIs', () => {
        const fileUri = Uri.file('/workspace/repo/src/nested/file.ts');
        expect(getRepoRelativePath(fileUri, root)).toBe('/src/nested/file.ts');

        const viewUri = Uri.from({
            scheme: 'jj-view',
            path: '/src/nested/file.ts',
        });
        expect(getRepoRelativePath(viewUri, root)).toBe('/src/nested/file.ts');
    });

    it('computes repo relative path for non-existent/deleted files without throwing', () => {
        clearCanonicalRootCache();
        const deletedFileUri = Uri.file(path.join(root, 'deleted-file.txt'));
        expect(getRepoRelativePath(deletedFileUri, root)).toBe('/deleted-file.txt');
    });

    it('can clear canonical root cache', () => {
        expect(() => clearCanonicalRootCache()).not.toThrow();
    });
});

describe('decodeJjViewQuery and encodeJjViewQuery', () => {
    it('round-trips diff query correctly', () => {
        const queryStr = encodeJjViewQuery({
            mode: 'diff',
            root: '/root',
            base: 'rev1',
            side: 'left',
        });
        const uri = Uri.from({ scheme: 'jj-view', path: '/file.ts', fragment: queryStr });
        const decoded = decodeJjViewQuery(uri);

        expect(decoded.mode).toBe('diff');
        if (decoded.mode === 'diff') {
            expect(decoded.base).toBe('rev1');
            expect(decoded.side).toBe('left');
            expect(decoded.root).toBe('/root');
        }
    });

    it('throws on invalid side', () => {
        const uri = Uri.from({ scheme: 'jj-view', path: '/file.ts', fragment: 'base=rev1&side=middle' });
        expect(() => decodeJjViewQuery(uri)).toThrow('Invalid side');
    });
});
