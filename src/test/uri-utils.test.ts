/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import type { HostFs } from '../core/host/host-system';
import { createJjOutputSchemas } from '../core/jj-schemas';
import type { JjStatusEntry } from '../core/jj-types';
import {
    isFilesystemRootPath,
    normalizeRepoSeparators,
    pathBasename,
    pathDirname,
    pathExtname,
    pathIsAbsolute,
    pathJoin,
    pathNormalize,
    pathRelative,
    pathResolve,
    stripLeadingSeparators,
    toFsComparisonKey,
    unquoteGitPath,
} from '../core/path-utils';
import {
    clearCanonicalRootCache,
    createCommitDetailsUri,
    createDiffUris,
    createRepoFileUri,
    createRevisionUri,
    createTextContentUri,
    createUploadedFileUri,
    decodeJjViewQuery,
    encodeJjViewQuery,
    fnv1aHash,
    getFsPathFromUri,
    getOriginalResourceUri,
    getRepoRelativePath,
    getRevisionFromUri,
    isInsideRelativePath,
    isJjScheme,
    isWorkingCopyRevision,
    parseCommitDetailsUri,
    resolveInsideRealRootAsync,
    resolvePathAgainstRealRootAsync,
    toFileUri,
    toForwardSlash,
    Uri,
} from '../core/uri-utils';
import './vitest-utils';
import { createMock } from './test-utils';
import { createVscodeMock } from './vscode-mock';

// Mock vscode
vi.mock('vscode', () => createVscodeMock({}));

const ENCODED_AT = '%40';

describe('toForwardSlash', () => {
    it('replaces backslashes with forward slashes and preserves empty string', () => {
        expect(toForwardSlash('C:\\path\\to\\file.txt')).toBe('C:/path/to/file.txt');
        expect(toForwardSlash('foo/bar/baz')).toBe('foo/bar/baz');
        expect(toForwardSlash('')).toBe('');
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
        expect(leftUri.path).toBe('/root/file.txt');
        expect(leftUri.fragment).toContain('root=%2Froot');
        expect(leftUri.fragment).toContain('base=rev1');
        expect(leftUri.fragment).toContain('side=left');

        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.path).toBe('/root/file.txt');
        expect(rightUri.path).toBe(leftUri.path);
        expect(rightUri.fragment).toContain('root=%2Froot');
        expect(rightUri.fragment).toContain('base=rev1');
        expect(rightUri.fragment).toContain('side=right');
    });

    it('creates correct URIs for working copy (rev=@) with matching paths', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        const revision = '@';

        const { leftUri, rightUri } = createDiffUris(entry, revision, root);

        expect(leftUri.scheme).toBe('jj-view');
        expect(leftUri.path).toBe('/root/file.txt');
        expect(leftUri.fragment).toContain(`base=${ENCODED_AT}`);
        expect(leftUri.fragment).toContain('side=left');

        // Working copy should use file scheme for right side and match leftUri.path
        expect(rightUri.scheme).toBe('file');
        expect(rightUri.path).toBe(leftUri.path);
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
        expect(leftUri.path).toBe('/root/old.txt');
        expect(leftUri.fragment).toContain('base=rev1');
        expect(leftUri.fragment).toContain('side=left');

        // Right side should use new path
        expect(rightUri.path).toBe('/root/new.txt');
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
        expect(leftUri.path).toBe('/root/deleted.txt');
        expect(leftUri.fragment).toContain(`base=${ENCODED_AT}`);
        expect(leftUri.fragment).toContain('side=left');

        // Removed files in working copy should use jj-view scheme for right side
        // to avoid "File not found" errors in VS Code.
        expect(rightUri.scheme).toBe('jj-view');
        expect(rightUri.path).toBe('/root/deleted.txt');
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
        const { leftUri, rightUri } = createDiffUris(entry, revision, root, {
            workingCopyChangeId: 'commit-123',
        });

        expect(rightUri.scheme).toBe('file');
        expect(rightUri.path).toBe(leftUri.path);
        expect(rightUri.fsPath).toBeSameFsPath('/root/file.txt');
    });

    it('uses jj-edit scheme for editable ancestor commits', () => {
        const entry: JjStatusEntry = {
            path: 'file.txt',
            status: 'modified',
        };
        const revision = 'rev1';
        const { leftUri, rightUri } = createDiffUris(entry, revision, root, { editable: true });

        expect(rightUri.scheme).toBe('jj-edit');
        expect(rightUri.path).toBe('/root/file.txt');
        expect(rightUri.path).toBe(leftUri.path);
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

    it('creates full repository path URI with fragment root from absolute path', () => {
        const uri = createRevisionUri(root, '/workspace/repo/src/sub/file.ts', 'main');
        expect(uri.scheme).toBe('jj-view');
        expect(uri.path).toBe('/workspace/repo/src/sub/file.ts');
        expect(uri.fragment).toContain('root=%2Fworkspace%2Frepo');
        expect(uri.fragment).toContain('revision=main');
    });

    it('creates full repository path URI from relative path input', () => {
        const uri = createRevisionUri(root, 'src/sub/file.ts', 'main');
        expect(uri.scheme).toBe('jj-view');
        expect(uri.path).toBe('/workspace/repo/src/sub/file.ts');
        expect(uri.fragment).toContain('root=%2Fworkspace%2Frepo');
        expect(uri.fragment).toContain('revision=main');
    });

    it('handles Windows-style absolute paths and encodes root in fragment', () => {
        const windowsRoot = 'C:\\workspace\\repo';
        const windowsPath = 'C:\\workspace\\repo\\src\\sub\\file.ts';

        const uri = createRevisionUri(windowsRoot, windowsPath, 'main');

        expect(uri.scheme).toBe('jj-view');
        expect(uri.path).toBe('/C:/workspace/repo/src/sub/file.ts');
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

    it('generates original resource URI with jj-view scheme matching file URI path', () => {
        const fileUri = Uri.file('/workspace/repo/src/index.ts');
        const origUri = getOriginalResourceUri(root, fileUri);

        expect(origUri.scheme).toBe('jj-view');
        expect(origUri.path).toBe('/workspace/repo/src/index.ts');
        expect(origUri.path).toBe(fileUri.path);
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

        const fullViewUri = createRevisionUri(root, 'src/nested/file.ts', '@-');
        expect(getRepoRelativePath(fullViewUri, root)).toBe('/src/nested/file.ts');
    });

    it('computes repo relative path for non-existent/deleted files without throwing', () => {
        clearCanonicalRootCache();
        const deletedFileUri = Uri.file(path.join(root, 'deleted-file.txt'));
        expect(getRepoRelativePath(deletedFileUri, root)).toBe('/deleted-file.txt');
    });

    it('returns root slash for repo root URI itself', () => {
        const rootUri = Uri.file(root);
        expect(getRepoRelativePath(rootUri, root)).toBe('/');
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

describe('fnv1aHash', () => {
    it('generates deterministic 8-char hex strings', () => {
        const hash1 = fnv1aHash('test-string');
        const hash2 = fnv1aHash('test-string');
        const hash3 = fnv1aHash('different-string');
        expect(hash1).toBe(hash2);
        expect(hash1).not.toBe(hash3);
        expect(hash1).toMatch(/^[0-9a-f]{8}$/);
    });

    it('produces known FNV-1a 32-bit test vectors', () => {
        expect(fnv1aHash('')).toBe('811c9dc5');
        expect(fnv1aHash('a')).toBe('e40c292c');
    });

    it('handles unicode strings and produces 8-char zero-padded strings', () => {
        const unicodeHash = fnv1aHash('日本語_emoji_🚀');
        expect(unicodeHash).toMatch(/^[0-9a-f]{8}$/);
        expect(fnv1aHash('')).toHaveLength(8);
    });
});

describe('pathe cross-platform contract', () => {
    it('isAbsolute detects POSIX and Windows absolute paths', () => {
        expect(path.isAbsolute('/foo/bar')).toBe(true);
        expect(path.isAbsolute('C:/foo/bar')).toBe(true);
        expect(path.isAbsolute('c:/foo/bar')).toBe(true);
        expect(path.isAbsolute('foo/bar')).toBe(false);
        expect(path.isAbsolute('./foo')).toBe(false);
        expect(path.isAbsolute('../foo')).toBe(false);
        expect(path.isAbsolute('')).toBe(false);
    });

    it('normalize handles slashes, relative segments, and Windows drive letters', () => {
        expect(path.normalize('foo\\bar\\baz')).toBe('foo/bar/baz');
        expect(path.normalize('/foo/bar/../baz')).toBe('/foo/baz');
        expect(path.normalize('/foo/./bar')).toBe('/foo/bar');
        expect(path.normalize('C:\\workspace\\..\\repo')).toBe('C:/repo');
        expect(path.normalize('')).toBe('.');
    });

    it('join joins segments and normalizes separators to forward slash', () => {
        expect(path.join('foo', 'bar', 'baz')).toBe('foo/bar/baz');
        expect(path.join('/foo', 'bar/../baz')).toBe('/foo/baz');
        expect(path.join('C:/repo', 'src', 'index.ts')).toBe('C:/repo/src/index.ts');
        expect(path.join()).toBe('.');
    });

    it('dirname and basename extract path segments correctly', () => {
        expect(path.dirname('/foo/bar/baz.txt')).toBe('/foo/bar');
        expect(path.dirname('/foo')).toBe('/');
        expect(path.dirname('foo')).toBe('.');
        expect(path.dirname('C:/foo/bar')).toBe('C:/foo');
        expect(path.dirname('C:/')).toBe('/');

        expect(path.basename('/foo/bar/baz.txt')).toBe('baz.txt');
        expect(path.basename('/foo/bar/baz.txt', '.txt')).toBe('baz');
        expect(path.basename('C:/foo/bar/')).toBe('bar');
    });

    it('extname extracts extensions', () => {
        expect(path.extname('/foo/bar/baz.txt')).toBe('.txt');
        expect(path.extname('index.html')).toBe('.html');
        expect(path.extname('.gitignore')).toBe('');
        expect(path.extname('noext')).toBe('');
    });

    it('resolve resolves absolute sequences', () => {
        expect(path.resolve('/base', 'sub', 'file.txt')).toBe('/base/sub/file.txt');
        expect(path.resolve('/base', '/absolute/path')).toBe('/absolute/path');
        expect(path.resolve('C:/base', 'sub')).toBe('C:/base/sub');
    });

    it('relative computes relative paths accurately across platforms', () => {
        expect(path.relative('/a/b', '/a/b/c/d')).toBe('c/d');
        expect(path.relative('/a/b/c', '/a/b/d')).toBe('../d');
        expect(path.relative('/a/b', '/a/b')).toBe('');
        expect(path.relative('C:/workspace/repo', 'C:/workspace/repo/src/file.ts')).toBe('src/file.ts');
    });

    describe('createUploadedFileUri and createTextContentUri', () => {
        it('creates and decodes uploaded file URI with full parameters', () => {
            const uri = createUploadedFileUri('/repo/root', 'src/file.ts', {
                changeId: 'I12345678',
                commitId: 'rev-commit-id',
                blobSha: 'blob123',
                remoteRevision: 'remote-rev-456',
                changeNumber: 12345,
            });

            expect(uri.scheme).toBe('jj-view');
            expect(uri.path).toBe('/repo/root/src/file.ts');

            const query = decodeJjViewQuery(uri);
            expect(query.mode).toBe('uploaded');
            if (query.mode === 'uploaded') {
                expect(query.changeId).toBe('I12345678');
                expect(query.commitId).toBe('rev-commit-id');
                expect(query.blobSha).toBe('blob123');
                expect(query.remoteRevision).toBe('remote-rev-456');
                expect(query.changeNumber).toBe(12345);
            }
        });

        it('treats non-numeric changeNumber as undefined instead of NaN', () => {
            const uri = Uri.parse('jj-view:///src/file.ts#mode=uploaded&changeId=I123&changeNumber=notanumber');
            const query = decodeJjViewQuery(uri);
            expect(query.mode).toBe('uploaded');
            if (query.mode === 'uploaded') {
                expect(query.changeNumber).toBeUndefined();
            }
        });

        it('creates and decodes text content URI', () => {
            const uri = createTextContentUri('/repo/root', 'COMMIT_MSG', 'Title\n\nBody message');
            expect(uri.scheme).toBe('jj-view');
            expect(uri.path).toBe('/COMMIT_MSG');

            const query = decodeJjViewQuery(uri);
            expect(query.mode).toBe('text');
            if (query.mode === 'text') {
                expect(query.text).toBe('Title\n\nBody message');
            }
        });
    });
});

describe('resolvePathAgainstRealRootAsync and resolveInsideRealRootAsync', () => {
    it('performs a single ancestor walk for an outside-root missing path', async () => {
        const calls: string[] = [];
        const realMap = new Map<string, string>([
            ['/outside', '/real/outside'],
            ['/real/repo', '/real/repo'],
        ]);
        const stubFs = createMock<HostFs>({
            realpath: async (targetPath: string) => {
                calls.push(targetPath);
                const resolved = realMap.get(path.normalize(targetPath));
                if (resolved !== undefined) {
                    return resolved;
                }
                throw Object.assign(new Error(`ENOENT: ${targetPath}`), { code: 'ENOENT' });
            },
        });

        const target = '/outside/missing-a/missing-b/ghost.txt';
        const res = await resolvePathAgainstRealRootAsync(target, '/real/repo', stubFs);
        expect(res).toEqual({
            inside: false,
            resolvedPath: '/real/outside/missing-a/missing-b/ghost.txt',
        });

        expect(calls).toEqual([
            '/outside/missing-a/missing-b',
            '/outside/missing-a',
            '/outside',
            '/outside/missing-a/missing-b/ghost.txt',
        ]);

        calls.length = 0;
        expect(await resolveInsideRealRootAsync(target, '/real/repo', stubFs)).toBeUndefined();
        expect(calls).toEqual([
            '/outside/missing-a/missing-b',
            '/outside/missing-a',
            '/outside',
            '/outside/missing-a/missing-b/ghost.txt',
        ]);
    });

    it('preserves tracked leaf symlinks inside realRoot without dereferencing the leaf', async () => {
        const calls: string[] = [];
        const realMap = new Map<string, string>([
            ['/ws-link/sub', '/real/repo/sub'],
            ['/ws-link/sub/leaf-link.txt', '/outside/external.txt'],
        ]);
        const stubFs = createMock<HostFs>({
            realpath: async (targetPath: string) => {
                calls.push(targetPath);
                const resolved = realMap.get(path.normalize(targetPath));
                if (resolved !== undefined) {
                    return resolved;
                }
                throw Object.assign(new Error(`ENOENT: ${targetPath}`), { code: 'ENOENT' });
            },
        });

        const res = await resolvePathAgainstRealRootAsync('/ws-link/sub/leaf-link.txt', '/real/repo', stubFs);
        expect(res).toEqual({ inside: true, relativePath: 'sub/leaf-link.txt' });
        expect(calls).toEqual(['/ws-link/sub']);
    });

    it('resolves an outside symlink whose target lands inside realRoot', async () => {
        const realMap = new Map<string, string>([
            ['/outside', '/outside'],
            ['/outside/link.txt', '/real/repo/nested/target.txt'],
        ]);
        const stubFs = createMock<HostFs>({
            realpath: async (targetPath: string) => {
                const resolved = realMap.get(path.normalize(targetPath));
                if (resolved !== undefined) {
                    return resolved;
                }
                throw Object.assign(new Error(`ENOENT: ${targetPath}`), { code: 'ENOENT' });
            },
        });

        const res = await resolvePathAgainstRealRootAsync('/outside/link.txt', '/real/repo', stubFs);
        expect(res).toEqual({ inside: true, relativePath: 'nested/target.txt' });
        expect(await resolveInsideRealRootAsync('/outside/link.txt', '/real/repo', stubFs)).toBe('nested/target.txt');
    });

    it('handles unresolvable roots and Windows drive-letter casing cleanly', async () => {
        const stubFs = createMock<HostFs>({
            realpath: async (targetPath: string) => {
                if (targetPath === 'C:/repo/sub') {
                    return 'c:/repo/sub';
                }
                throw Object.assign(new Error(`ENOENT: ${targetPath}`), { code: 'ENOENT' });
            },
        });

        expect(await resolvePathAgainstRealRootAsync('/unmapped/a/b.txt', '/real/repo', stubFs)).toBeUndefined();
        expect(await resolvePathAgainstRealRootAsync('C:\\repo\\sub\\file.ts', 'C:\\repo', stubFs)).toEqual({
            inside: true,
            relativePath: 'sub/file.ts',
        });
    });

    it('getRepoRelativePath handles empty root and external embedded root safely', () => {
        const embeddedUri = Uri.from({
            scheme: 'jj-view',
            path: '/repo/src/index.ts',
            fragment: encodeJjViewQuery({ mode: 'diff', root: '/repo', base: 'abc', side: 'left' }),
        });
        expect(getRepoRelativePath(embeddedUri, '')).toBe('/src/index.ts');

        const virtualNoRootUri = Uri.from({
            scheme: 'jj-view',
            path: '/src/plain.ts',
        });
        expect(getRepoRelativePath(virtualNoRootUri, '')).toBe('/src/plain.ts');

        const otherRepoUri = Uri.from({
            scheme: 'jj-view',
            path: '/other-repo/src/foreign.ts',
            fragment: encodeJjViewQuery({ mode: 'diff', root: '/other-repo', base: 'abc', side: 'left' }),
        });
        expect(getRepoRelativePath(otherRepoUri, '/repo')).toBe('/../other-repo/src/foreign.ts');
    });
});

describe('platform-aware backslash filename handling (POSIX vs win32)', () => {
    it('preserves literal backslashes in path helpers on POSIX while normalizing separators on win32', () => {
        expect(normalizeRepoSeparators('foo\\bar.txt', 'linux')).toBe('foo\\bar.txt');
        expect(normalizeRepoSeparators('sub/a\\b.txt', 'darwin')).toBe('sub/a\\b.txt');
        expect(normalizeRepoSeparators('sub\\a\\b.txt', 'win32')).toBe('sub/a/b.txt');

        expect(stripLeadingSeparators('\\foo.txt', 'linux')).toBe('\\foo.txt');
        expect(stripLeadingSeparators('/\\foo.txt', 'linux')).toBe('\\foo.txt');
        expect(stripLeadingSeparators('\\foo.txt', 'win32')).toBe('foo.txt');

        expect(isInsideRelativePath('..\\foo.txt', 'linux')).toBe(true);
        expect(isInsideRelativePath('..\\foo.txt', 'win32')).toBe(false);
        expect(isInsideRelativePath('C:\\foo.txt', 'linux')).toBe(true);
        expect(isInsideRelativePath('C:\\foo.txt', 'win32')).toBe(false);

        expect(pathNormalize('foo\\bar.txt', 'linux')).toBe('foo\\bar.txt');
        expect(pathNormalize('sub\\bar.txt', 'win32')).toBe('sub/bar.txt');

        expect(pathJoin(['/workspace/repo', 'foo\\bar.txt'], 'linux')).toBe('/workspace/repo/foo\\bar.txt');
        expect(pathJoin(['C:\\workspace\\repo', 'sub\\bar.txt'], 'win32')).toBe('C:/workspace/repo/sub/bar.txt');

        expect(pathResolve(['/workspace/repo', 'sub/a\\b.txt'], 'linux')).toBe('/workspace/repo/sub/a\\b.txt');
        expect(pathRelative('/workspace/repo', '/workspace/repo/foo\\bar.txt', 'linux')).toBe('foo\\bar.txt');
        expect(pathRelative('/workspace/repo', '/workspace/repo/sub/a\\b.txt', 'linux')).toBe('sub/a\\b.txt');

        expect(pathDirname('foo\\bar.txt', 'linux')).toBe('.');
        expect(pathDirname('sub/a\\b.txt', 'linux')).toBe('sub');
        expect(pathDirname('sub\\a\\b.txt', 'win32')).toBe('sub/a');

        expect(pathBasename('foo\\bar.txt', 'linux')).toBe('foo\\bar.txt');
        expect(pathBasename('sub/a\\b.txt', 'linux')).toBe('a\\b.txt');
        expect(pathBasename('sub\\a\\b.txt', 'win32')).toBe('b.txt');

        expect(pathExtname('a\\b.txt', 'linux')).toBe('.txt');
        expect(pathExtname('foo.d\\bar', 'linux')).toBe('.d\\bar');
        expect(pathExtname('foo.d\\bar', 'win32')).toBe('');

        expect(pathIsAbsolute('C:\\repo\\file.txt', 'linux')).toBe(false);
        expect(pathIsAbsolute('C:\\repo\\file.txt', 'win32')).toBe(true);
    });

    it('preserves literal backslashes in URIs and Zod schemas on POSIX', () => {
        const root = '/workspace/repo';
        const entry: JjStatusEntry = { path: 'sub/a\\b.txt', status: 'modified' };
        const diffUris = createDiffUris(entry, 'rev1', root, { editable: true, platform: 'linux' });
        expect(diffUris.leftUri.path).toBe('/workspace/repo/sub/a\\b.txt');
        expect(diffUris.rightUri.scheme).toBe('jj-edit');
        expect(diffUris.rightUri.path).toBe('/workspace/repo/sub/a\\b.txt');
        expect(getRepoRelativePath(diffUris.leftUri, root, 'linux')).toBe('/sub/a\\b.txt');
        expect(getFsPathFromUri(diffUris.leftUri, 'linux')).toBe('/workspace/repo/sub/a\\b.txt');

        const wcUris = createDiffUris({ path: 'foo\\bar.txt', status: 'modified' }, '@', root, {
            platform: 'linux',
        });
        expect(wcUris.resourceUri.scheme).toBe('file');
        expect(wcUris.resourceUri.path).toBe('/workspace/repo/foo\\bar.txt');
        if (process.platform !== 'win32') {
            expect(wcUris.resourceUri.fsPath).toBeSameFsPath('/workspace/repo/foo\\bar.txt');
        }
        expect(getFsPathFromUri(wcUris.resourceUri, 'linux')).toBe('/workspace/repo/foo\\bar.txt');
        expect(getRepoRelativePath(wcUris.resourceUri, root, 'linux')).toBe('/foo\\bar.txt');
        expect(getOriginalResourceUri(root, wcUris.resourceUri, 'linux').path).toBe('/workspace/repo/foo\\bar.txt');

        const revUri = createRevisionUri(root, '/workspace/repo/foo\\bar.txt', 'rev1', 'linux');
        expect(revUri.path).toBe('/workspace/repo/foo\\bar.txt');
        expect(getRepoRelativePath(revUri, root, 'linux')).toBe('/foo\\bar.txt');

        const uploadedUri = createUploadedFileUri(root, 'foo\\bar.txt', { changeId: 'I123', platform: 'linux' });
        expect(uploadedUri.path).toBe('/workspace/repo/foo\\bar.txt');
        expect(getRepoRelativePath(uploadedUri, root, 'linux')).toBe('/foo\\bar.txt');

        const textUri = createTextContentUri(root, 'foo\\bar.txt', 'hello', 'linux');
        expect(textUri.path).toBe('/foo\\bar.txt');

        const posixSchemas = createJjOutputSchemas('linux');
        expect(posixSchemas.fileChange.parse({ path: 'foo\\bar.txt', status: 'added' })).toEqual({
            path: 'foo\\bar.txt',
            status: 'added',
        });

        const winSchemas = createJjOutputSchemas('win32');
        expect(winSchemas.fileChange.parse({ path: 'sub\\bar.txt', status: 'added' })).toEqual({
            path: 'sub/bar.txt',
            status: 'added',
        });
    });

    it('normalizes backslashes to forward slashes in URIs when targeting win32', () => {
        const winRoot = 'C:\\workspace\\repo';
        const winEntry: JjStatusEntry = { path: 'sub\\file.txt', status: 'modified' };
        const diffUris = createDiffUris(winEntry, 'rev1', winRoot, { editable: false, platform: 'win32' });
        expect(diffUris.leftUri.path).toBe('/C:/workspace/repo/sub/file.txt');
        expect(diffUris.rightUri.path).toBe('/C:/workspace/repo/sub/file.txt');
        expect(getRepoRelativePath(diffUris.leftUri, winRoot, 'win32')).toBe('/sub/file.txt');
    });

    it('handles Windows UNC shares, drive-relative escapes, mixed-case Linux roots, inferRootPlatform, and unquoteGitPath', () => {
        expect(isFilesystemRootPath('//server/share', 'win32')).toBe(true);
        expect(isFilesystemRootPath('//server/share/', 'win32')).toBe(true);
        expect(pathNormalize('//server/share', 'win32')).toBe('//server/share');
        expect(pathNormalize('//server/share/..', 'win32')).toBe('//server/share');
        expect(pathJoin(['//server/share', 'sub\\file.txt'], 'win32')).toBe('//server/share/sub/file.txt');
        expect(pathResolve(['//server/share', 'sub', '..', '..', 'outside.txt'], 'win32')).toBe(
            '//server/share/outside.txt',
        );
        expect(pathRelative('//server/share/a', '//server/other/b', 'win32')).toBe('//server/other/b');
        expect(pathDirname('//server/share', 'win32')).toBe('//server/share');
        expect(pathBasename('//server/share', 'win32')).toBe('');
        expect(pathBasename('//server/share/file.txt', 'win32')).toBe('file.txt');

        // Drive-relative escapes must be blocked on win32, preserved on POSIX
        expect(isInsideRelativePath('C:..\\secret.txt', 'win32')).toBe(false);
        expect(isInsideRelativePath('C:foo.txt', 'win32')).toBe(false);
        expect(isInsideRelativePath('C:..\\secret.txt', 'linux')).toBe(true);

        // createRevisionUri respects case sensitivity per OS, normalizes .., and infers platform from root
        const linuxMismatch = createRevisionUri('/Repo', '/repo/foo\\bar.txt', 'rev1', 'linux');
        expect(linuxMismatch.path).toBe('/repo/foo\\bar.txt');
        const lowerRepoUri = createRevisionUri('/repo', '/repo/foo\\bar.txt', 'rev1', 'linux');
        expect(getRepoRelativePath(lowerRepoUri, '/Repo', 'linux')).toBe('/../repo/foo\\bar.txt');
        const linuxInsideTraversal = createRevisionUri('/repo', '/repo/sub/../inside.txt', 'rev1', 'linux');
        expect(linuxInsideTraversal.path).toBe('/repo/inside.txt');
        const linuxOutsideTraversal = createRevisionUri('/repo', '/repo/sub/../../outside.txt', 'rev1', 'linux');
        expect(linuxOutsideTraversal.path).toBe('/outside.txt');
        expect(getRepoRelativePath(Uri.file('/outside.txt'), '/repo', 'linux')).toBe('/../outside.txt');
        const darwinMatch = createRevisionUri('/Repo', '/repo/foo\\bar.txt', 'rev1', 'darwin');
        expect(darwinMatch.path).toBe('/Repo/foo\\bar.txt');

        const uploadedInferredWin = createUploadedFileUri('C:\\repo', 'sub\\file.txt', { changeId: 'I1' });
        expect(uploadedInferredWin.path).toBe('/C:/repo/sub/file.txt');
        expect(getRepoRelativePath(uploadedInferredWin, 'C:\\repo')).toBe('/sub/file.txt');
        const textInferredWin = createTextContentUri('C:\\repo', 'sub\\note.txt', 'hello');
        expect(textInferredWin.path).toBe('/sub/note.txt');
        if (process.platform !== 'win32') {
            const revInferredPosix = createRevisionUri('/repo', 'C:\\foo.txt', 'rev1');
            expect(revInferredPosix.path).toBe('/repo/C:\\foo.txt');
            expect(getRepoRelativePath(revInferredPosix, '/repo')).toBe('/C:\\foo.txt');
        }

        // getFsPathFromUri preserves POSIX C:\foo.txt inside POSIX root without triggering Windows drive heuristics
        const posixColonUri = createUploadedFileUri('/repo', 'C:\\foo.txt', { changeId: 'I1', platform: 'linux' });
        expect(getFsPathFromUri(posixColonUri, 'linux')).toBe('/repo/C:\\foo.txt');

        // unquoteGitPath preserves literal backslashes and decodes UTF-8 octal sequences
        expect(unquoteGitPath('"foo\\\\bar.txt"')).toBe('foo\\bar.txt');
        expect(unquoteGitPath('"caf\\303\\251\\\\latte.txt"')).toBe('café\\latte.txt');
        expect(unquoteGitPath('"line\\t\\n\\\\end"')).toBe('line\t\n\\end');
    });

    it('round-trips UNC custom URIs, mixed-case roots, options objects, and leading slashes across platforms (#435)', () => {
        for (const uncRoot of ['//server/share/repo', '\\\\server\\share\\repo']) {
            const diffUris = createDiffUris({ path: 'sub\\file.txt', status: 'modified' }, 'rev1', uncRoot, {
                editable: true,
                platform: 'win32',
            });
            expect(diffUris.leftUri.authority).toBe('server');
            expect(diffUris.rightUri.authority).toBe('server');
            expect(getFsPathFromUri(diffUris.leftUri, 'win32')).toBe('\\\\server\\share\\repo\\sub\\file.txt');
            expect(getFsPathFromUri(diffUris.rightUri, 'win32')).toBe('\\\\server\\share\\repo\\sub\\file.txt');
            expect(getRepoRelativePath(diffUris.leftUri, uncRoot, 'win32')).toBe('/sub/file.txt');
            expect(getRepoRelativePath(diffUris.rightUri, uncRoot, 'win32')).toBe('/sub/file.txt');

            const inferredView = createRepoFileUri(uncRoot, 'sub\\other.txt', 'jj-view');
            expect(inferredView.authority).toBe('server');
            expect(getRepoRelativePath(inferredView, uncRoot)).toBe('/sub/other.txt');
        }

        // Mixed-case roots match case-insensitively on win32/darwin while preserving case sensitivity on linux
        const winUpperRoot = 'C:\\Workspace\\Repo';
        const winLowerUri = Uri.file('c:\\workspace\\repo\\src\\File.ts');
        expect(getRepoRelativePath(winLowerUri, winUpperRoot, 'win32')).toBe('/src/File.ts');

        const darwinUpperRoot = '/Repo';
        const darwinLowerUri = Uri.from({ scheme: 'file', path: '/repo/foo\\bar.txt' });
        expect(getRepoRelativePath(darwinLowerUri, darwinUpperRoot, 'darwin')).toBe('/foo\\bar.txt');
        expect(getRepoRelativePath(darwinLowerUri, darwinUpperRoot, 'linux')).toBe('/../repo/foo\\bar.txt');

        // Explicit POSIX platform keeps toFsComparisonKey case-sensitive and preserves literal backslashes / drive-like dirs
        expect(toFsComparisonKey('C:\\Foo.txt', 'linux')).toBe('C:\\Foo.txt');
        const optionsUri = createRepoFileUri('/repo', 'foo\\bar.txt', 'file', { platform: 'linux' });
        expect(optionsUri.path).toBe('/repo/foo\\bar.txt');
        expect(optionsUri.fragment).toBe('');

        expect(createTextContentUri('/repo', '//leading/path.txt', 'hi', 'linux').path).toBe('/leading/path.txt');
        expect(getFsPathFromUri(Uri.from({ scheme: 'file', path: '/C:/foo.txt' }), 'linux')).toBe('/C:/foo.txt');
    });
});
