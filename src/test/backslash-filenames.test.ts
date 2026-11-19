/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjDecorationModel } from '../core/jj-decoration-model';
import { JjEditFsService } from '../core/jj-edit-fs-service';
import { JjMergeService } from '../core/jj-merge-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import type { JjStatusEntry } from '../core/jj-types';
import { JjViewFsService } from '../core/jj-view-fs-service';
import { createDiffUris, getFsPathFromUri, getRepoRelativePath, Uri } from '../core/uri-utils';
import { formatRemoteFileUrl } from '../utils/remote-url-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';
import './vitest-utils';

describe.skipIf(process.platform === 'win32')('Literal backslashes in POSIX file names (#435)', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let jj: JjService;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));
        repoManager = new JjRepositoryManager(new CodeForgeRegistry(), createMockLogOutputChannel(), host);
        const registered = await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        if (!registered) {
            throw new Error('Failed to register TestRepo');
        }
        jj = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(async () => {
        await repoManager.dispose();
        await repo.dispose();
    });

    test('preserves literal backslashes in log, changes, content, diff, and hunks', async () => {
        const nodes = await buildGraph(repo, [
            {
                label: 'base',
                description: 'add backslash files',
                files: {
                    'foo\\bar.txt': 'alpha\nbeta\ngamma\n',
                    'sub/a\\b.txt': 'nested line 1\n',
                },
            },
            {
                label: 'child',
                parents: ['base'],
                description: 'edit backslash files',
                files: {
                    'foo\\bar.txt': 'alpha\nbeta edited\ngamma\ndelta\n',
                    'sub/a\\b.txt': 'nested line 1\nnested line 2\n',
                },
            },
        ]);

        const entries = await jj.getLog({ revision: nodes.child.changeId, limit: 1 });
        expect(entries).toHaveLength(1);
        expect(entries[0].changes?.map((c) => c.path).sort()).toEqual(['foo\\bar.txt', 'sub/a\\b.txt']);

        const changes = await jj.getChanges(nodes.child.changeId);
        expect(changes.map((c) => c.path).sort()).toEqual(['foo\\bar.txt', 'sub/a\\b.txt']);

        const between = await jj.getChangesBetween(nodes.base.changeId, nodes.child.changeId);
        expect(between.map((c) => c.path).sort()).toEqual(['foo\\bar.txt', 'sub/a\\b.txt']);

        expect(await jj.getFileContent('foo\\bar.txt', nodes.base.changeId)).toBe('alpha\nbeta\ngamma\n');
        expect(await jj.cat('sub/a\\b.txt', nodes.child.changeId)).toBe('nested line 1\nnested line 2\n');

        const diffText = await jj.getDiff(nodes.child.changeId, 'foo\\bar.txt');
        expect(diffText).toContain('diff --git a/foo\\bar.txt b/foo\\bar.txt');
        expect(diffText).toContain('+beta edited');

        const diffContent = await jj.getDiffContent(nodes.child.changeId, 'sub/a\\b.txt');
        expect(diffContent).toEqual({
            left: 'nested line 1\n',
            right: 'nested line 1\nnested line 2\n',
        });

        const hunksMap = await jj.getCommitDiffHunks(nodes.base.commitId, nodes.child.commitId, [
            'foo\\bar.txt',
            'sub/a\\b.txt',
        ]);
        expect(hunksMap?.get('foo\\bar.txt')).toEqual([
            { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
            { oldStart: 3, oldCount: 0, newStart: 4, newCount: 1 },
        ]);
        expect(hunksMap?.get('sub/a\\b.txt')).toEqual([{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }]);
    });

    test('reads binary files and diffs cleanly with literal backslashes', async () => {
        const pngV1 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
        const pngV2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);

        repo.writeBinaryFile('bin\\pic.png', pngV1);
        repo.describe('add binary backslash file');
        const baseRev = repo.getChangeId('@');
        repo.new();
        repo.writeBinaryFile('bin\\pic.png', pngV2);

        const baseBytes = await jj.getFileBinaryContent('bin\\pic.png', baseRev);
        expect(Array.from(baseBytes)).toEqual(Array.from(pngV1));

        const wcBytes = await jj.getFileBinaryContent('bin\\pic.png', '@');
        expect(Array.from(wcBytes)).toEqual(Array.from(pngV2));

        const diffBinary = await jj.getDiffBinaryContent('@', 'bin\\pic.png');
        expect(Array.from(diffBinary.left)).toEqual(Array.from(pngV1));
        expect(Array.from(diffBinary.right)).toEqual(Array.from(pngV2));
    });

    test('supports JjViewFsService, JjEditFsService, and setFileContent on backslash filenames', async () => {
        const nodes = await buildGraph(repo, [
            {
                label: 'base',
                description: 'initial files',
                files: {
                    'foo\\bar.txt': 'v1\n',
                    'sub/a\\b.txt': 'nested v1\n',
                },
            },
            {
                label: 'parent',
                parents: ['base'],
                description: 'mutable parent',
                files: {
                    'foo\\bar.txt': 'v2\n',
                    'sub/a\\b.txt': 'nested v2\n',
                },
            },
            {
                label: 'wc',
                parents: ['parent'],
                description: 'working copy',
            },
        ]);

        const viewFs = new JjViewFsService(repoManager);
        const editFs = new JjEditFsService(repoManager);
        try {
            const diffUris = createDiffUris(
                { path: 'foo\\bar.txt', status: 'modified' },
                nodes.parent.changeId,
                repo.path,
                {
                    editable: true,
                },
            );
            expect(diffUris.leftUri.path).toBe(Uri.file(path.join(repo.path, 'foo\\bar.txt')).path);
            expect(diffUris.rightUri.scheme).toBe('jj-edit');
            expect(diffUris.rightUri.path).toBe(diffUris.leftUri.path);
            expect(getRepoRelativePath(diffUris.leftUri, repo.path)).toBe('/foo\\bar.txt');
            expect(getFsPathFromUri(diffUris.rightUri)).toBeSameFsPath(path.join(repo.path, 'foo\\bar.txt'));

            const wcUri = Uri.file(path.join(repo.path, 'sub/a\\b.txt'));
            expect(getRepoRelativePath(wcUri, repo.path)).toBe('/sub/a\\b.txt');
            expect(repoManager.getRepositoryForUri(wcUri)?.rootUri.fsPath).toBeSameFsPath(repo.path);

            const leftBytes = await viewFs.readFile(diffUris.leftUri);
            expect(new TextDecoder().decode(leftBytes)).toBe('v1\n');

            const editReadBytes = await editFs.readFile(diffUris.rightUri);
            expect(new TextDecoder().decode(editReadBytes)).toBe('v2\n');

            await editFs.writeFile(diffUris.rightUri, new TextEncoder().encode('v2 edited via jj-edit\n'));
            expect(repo.getFileContent(nodes.parent.changeId, 'foo\\bar.txt')).toBe('v2 edited via jj-edit\n');

            await jj.setFileContent(nodes.parent.changeId, 'sub/a\\b.txt', 'nested v2 direct edit\n');
            expect(repo.getFileContent(nodes.parent.changeId, 'sub/a\\b.txt')).toBe('nested v2 direct edit\n');
        } finally {
            viewFs.dispose();
            editFs.dispose();
        }
    });

    test('supports restore, splitFiles, squashRevision, absorb, and checkTrackedPaths', async () => {
        repo.writeFile('foo\\bar.txt', 'line 1\nline 2\nline 3\n');
        repo.writeFile('sub/a\\b.txt', 'nested base\n');
        repo.writeFile('.gitignore', 'ignored\\\\secret.txt\n');
        repo.describe('base commit');
        const baseRev = repo.getChangeId('@');

        repo.new();
        repo.writeFile('foo\\bar.txt', 'line 1 modified\nline 2\nline 3\n');
        repo.writeFile('sub/a\\b.txt', 'nested changed\n');
        repo.writeFile('ignored\\secret.txt', 'ignored content\n');

        // checkTrackedPaths tracks literal backslash files and respects .gitignore
        const tracked = await jj.checkTrackedPaths(['foo\\bar.txt', 'sub/a\\b.txt', 'ignored\\secret.txt']);
        expect(tracked.sort()).toEqual(['foo\\bar.txt', 'sub/a\\b.txt']);

        // absorb pulls compatible non-conflicting hunk change into base commit
        await jj.absorb({ paths: ['foo\\bar.txt'] });
        expect(repo.getFileContent(baseRev, 'foo\\bar.txt')).toBe('line 1 modified\nline 2\nline 3\n');
        // sub/a\b.txt was NOT included in absorb paths, so it stays in working copy
        expect((await jj.getChanges('@')).map((c) => c.path)).toEqual(['sub/a\\b.txt']);

        // modify both files in @, then test restore on foo\bar.txt only
        repo.writeFile('foo\\bar.txt', 'line 1 temp revert\nline 2\nline 3\n');
        await jj.restore(['foo\\bar.txt']);
        expect(fs.readFileSync(path.join(repo.path, 'foo\\bar.txt'), 'utf-8')).toBe(
            'line 1 modified\nline 2\nline 3\n',
        );

        // make another edit to both files, split foo\bar.txt before @
        repo.writeFile('foo\\bar.txt', 'line 1 split\nline 2\nline 3\n');
        repo.describe('combined changes');
        await jj.splitFiles({
            revision: '@',
            paths: ['foo\\bar.txt'],
            placement: 'before',
            message: 'split out foo backslash',
        });

        const logAfterSplit = await jj.getLog({ revision: '@-', limit: 1 });
        expect(logAfterSplit[0].changes?.map((c) => c.path)).toEqual(['foo\\bar.txt']);
        expect((await jj.getChanges('@')).map((c) => c.path)).toEqual(['sub/a\\b.txt']);

        // squash sub/a\b.txt into @-
        await jj.squashRevision({ paths: ['sub/a\\b.txt'], useDestinationMessage: true });
        expect(repo.getFileContent('@-', 'sub/a\\b.txt')).toBe('nested changed\n');
    });

    test('JjDecorationModel decorates modified and ignored backslash files accurately', async () => {
        repo.writeFile('foo\\bar.txt', 'tracked v1\n');
        repo.writeFile('.gitignore', 'ignored\\\\secret.txt\n');
        repo.describe('commit base');

        repo.new();
        repo.writeFile('foo\\bar.txt', 'tracked v2\n');
        repo.writeFile('sub/clean\\file.txt', 'clean tracked\n');
        repo.describe('add clean file');
        repo.new();
        repo.writeFile('foo\\bar.txt', 'tracked v3\n');
        repo.writeFile('ignored\\secret.txt', 'secret\n');

        const model = new JjDecorationModel(jj, repo.path);
        try {
            const scmMap = new Map<string, JjStatusEntry>();
            scmMap.set('/foo\\bar.txt', { path: 'foo\\bar.txt', status: 'modified' });
            model.updateScmAndTrackedStatus(scmMap);

            const modDec = await model.getDecoration(Uri.file(path.join(repo.path, 'foo\\bar.txt')));
            expect(modDec).toEqual({
                badge: 'M',
                tooltip: 'Modified',
                colorKey: 'gitDecoration.modifiedResourceForeground',
            });

            const cleanDec = await model.getDecoration(Uri.file(path.join(repo.path, 'sub/clean\\file.txt')));
            expect(cleanDec).toBeUndefined();

            repo.writeFile('.jj\\notes.txt', 'not jj internal dir\n');
            const dotJjBackslashDec = await model.getDecoration(Uri.file(path.join(repo.path, '.jj\\notes.txt')));
            expect(dotJjBackslashDec).toBeUndefined();

            const ignoredDec = await model.getDecoration(Uri.file(path.join(repo.path, 'ignored\\secret.txt')));
            expect(ignoredDec).toEqual({
                tooltip: 'Ignored',
                colorKey: 'gitDecoration.ignoredResourceForeground',
            });
        } finally {
            model.dispose();
        }
    });

    test('handles leading backslash, literal ..\\ prefix, spaces, conflicts, repo lookup, and remote URLs', async () => {
        const nodes = await buildGraph(repo, [
            {
                label: 'root',
                description: 'root commit',
                files: {
                    '\\foo.txt': 'leading v1\n',
                    '..\\foo.txt': 'dotdot backslash v1\n',
                    'a b\\c d.txt': 'spaces v1\n',
                    'conflict\\file.txt': 'base conflict line\n',
                },
            },
            {
                label: 'left',
                parents: ['root'],
                description: 'left conflict branch',
                files: {
                    '\\foo.txt': 'leading v2\n',
                    '..\\foo.txt': 'dotdot backslash v2\n',
                    'a b\\c d.txt': 'spaces v2\n',
                    'conflict\\file.txt': 'left conflict line\n',
                },
            },
            {
                label: 'right',
                parents: ['root'],
                description: 'right conflict branch',
                files: {
                    'conflict\\file.txt': 'right conflict line\n',
                },
            },
            {
                label: 'merge',
                parents: ['left', 'right'],
                description: 'merge with conflict',
                isCurrentWorkingCopy: true,
            },
        ]);

        const edgeFiles = ['\\foo.txt', '..\\foo.txt', 'a b\\c d.txt'];
        const tracked = await jj.checkTrackedPaths(edgeFiles);
        expect(tracked.sort()).toEqual([...edgeFiles].sort());

        for (const rel of edgeFiles) {
            expect(await jj.getFileContent(rel, nodes.left.changeId)).toBe(
                repo.getFileContent(nodes.left.changeId, rel),
            );
            const uris = createDiffUris({ path: rel, status: 'modified' }, nodes.left.changeId, repo.path, {
                platform: 'linux',
            });
            expect(uris.leftUri.path).toBe(Uri.file(path.join(repo.path, rel)).path);
            expect(uris.rightUri.path).toBe(uris.leftUri.path);
            expect(getFsPathFromUri(uris.leftUri, 'linux')).toBeSameFsPath(path.join(repo.path, rel));
            expect(getRepoRelativePath(uris.leftUri, repo.path, 'linux')).toBe(`/${rel}`);
        }

        // Exact restore restores only the targeted backslash file
        await jj.restore(['\\foo.txt'], { from: nodes.root.changeId, exact: true });
        expect(fs.readFileSync(path.join(repo.path, '\\foo.txt'), 'utf-8')).toBe('leading v1\n');
        expect(fs.readFileSync(path.join(repo.path, '..\\foo.txt'), 'utf-8')).toBe('dotdot backslash v2\n');

        // Conflict detection and JjMergeService resolution on conflict\file.txt
        expect(await jj.getConflictedFiles()).toEqual(['conflict\\file.txt']);
        const parts = await jj.getConflictParts('conflict\\file.txt');
        expect(parts.base).toBe('base conflict line\n');
        expect(parts.left).toBe('left conflict line\n');
        expect(parts.right).toBe('right conflict line\n');

        const mergeService = new JjMergeService(jj);
        const conflictPath = path.join(repo.path, 'conflict\\file.txt');
        const makeMergeUri = (part: string) =>
            Uri.from({
                scheme: 'jj-merge',
                path: '/conflict\\file.txt',
                query: new URLSearchParams({ path: conflictPath, part }).toString(),
            });
        expect(await mergeService.provideContent(makeMergeUri('base'))).toBe('base conflict line\n');
        expect(await mergeService.provideContent(makeMergeUri('left'))).toBe('left conflict line\n');
        expect(await mergeService.provideContent(makeMergeUri('right'))).toBe('right conflict line\n');

        // Repo discovery from nested/backslash file path
        const lookupHost = new FakeHostEnvironment();
        lookupHost.workspace.addFolder(Uri.file(repo.path));
        const freshManager = new JjRepositoryManager(new CodeForgeRegistry(), createMockLogOutputChannel(), lookupHost);
        try {
            const discovered = await freshManager.maybeRegisterRepositoryContainingUri(
                Uri.file(path.join(repo.path, 'a b\\c d.txt')),
            );
            expect(discovered).toBeDefined();
            expect(discovered?.rootUri.fsPath).toBeSameFsPath(repo.path);
        } finally {
            await freshManager.dispose();
        }

        // Remote URL encoding preserves literal backslash on POSIX while treating \ as path separator on win32
        expect(
            formatRemoteFileUrl({
                target: { kind: 'github', baseUrl: 'https://github.com/org/repo' },
                commitSha: 'deadbeef',
                relativePath: 'sub/foo\\bar.txt',
                platform: 'linux',
            }),
        ).toBe('https://github.com/org/repo/blob/deadbeef/sub/foo%5Cbar.txt');
        expect(
            formatRemoteFileUrl({
                target: { kind: 'github', baseUrl: 'https://github.com/org/repo' },
                commitSha: 'deadbeef',
                relativePath: 'sub\\bar.txt',
                platform: 'win32',
            }),
        ).toBe('https://github.com/org/repo/blob/deadbeef/sub/bar.txt');
    });
});
