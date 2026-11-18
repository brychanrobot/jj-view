/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { squashHunkIntoParentCommand, squashSelectionIntoParentCommand } from '../../core/commands/squash-selection';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { ScopedSymlink, ScopedTempDir } from '../scoped-helpers';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('squash-selection commands', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(async () => {
        vi.clearAllMocks();
        await repo.dispose();
    });

    describe('squashHunkIntoParentCommand', () => {
        test('squashes hunk based on index', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { 'initial.txt': 'initial' },
                },
                {
                    label: 'base',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nline2\nline3\nline4\nline5\n',
                        'other.txt': 'original other',
                    },
                },
                {
                    label: 'side',
                    parents: ['base'],
                    files: { 'side.txt': 'side' },
                },
                {
                    label: 'modified',
                    parents: ['base'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\nmodified4\nline5\n',
                        'other.txt': 'modified other',
                    },
                },
            ]);
            repo.edit(ids.modified.changeId);

            const uri = Uri.file(path.join(repo.path, fileName));

            await squashHunkIntoParentCommand(ctx, {
                uri,
                ranges: [{ startLine: 3, endLine: 3 }],
            });

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('line1\nline2\nline3\nmodified4\nline5\n');

            const wcContent = repo.getFileContent('@', fileName);
            expect(wcContent).toBe('line1\nmodified2\nline3\nmodified4\nline5\n');

            const wcDiffGit = repo.getDiff('@', { git: true });
            expect(wcDiffGit).toContain('+modified2');
            expect(wcDiffGit).not.toContain('+modified4');
        });
    });

    describe('squashSelectionIntoParentCommand', () => {
        test('squashes selection from editor', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { 'initial.txt': 'initial' },
                },
                {
                    label: 'base',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nline2\nline3\nline4\nline5\n',
                        'other.txt': 'original other',
                    },
                },
                {
                    label: 'side',
                    parents: ['base'],
                    files: { 'side.txt': 'side' },
                },
                {
                    label: 'modified',
                    parents: ['base'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\nmodified4\nline5\n',
                        'other.txt': 'modified other',
                    },
                },
            ]);
            repo.edit(ids.modified.changeId);

            const uri = Uri.file(path.join(repo.path, fileName)).with({
                query: 'jj-revision=@',
            });

            await squashSelectionIntoParentCommand(ctx, {
                uri,
                ranges: [{ startLine: 1, endLine: 1 }],
            });

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('line1\nmodified2\nline3\nline4\nline5\n');

            const wcDiffGit = repo.getDiff('@', { git: true });
            expect(wcDiffGit).toContain('+modified4');
            expect(wcDiffGit).not.toContain('+modified2');
        });

        test('squashes selection from jj-edit editor', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { [fileName]: 'line1\nline2\nline3\n' },
                },
                {
                    label: 'modified',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\n',
                    },
                },
            ]);

            const uri = Uri.file(path.join(repo.path, fileName)).with({
                scheme: 'jj-edit',
                query: `revision=${ids.modified.changeId}`,
            });

            await squashSelectionIntoParentCommand(ctx, {
                uri,
                ranges: [{ startLine: 1, endLine: 1 }],
            });

            const parentContent = repo.getFileContent(ids.root.changeId, fileName);
            expect(parentContent).toBe('line1\nmodified2\nline3\n');
        });

        test('squashes selection from jj-view diff editor', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { [fileName]: 'line1\nline2\nline3\n' },
                },
                {
                    label: 'modified',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\n',
                    },
                },
            ]);

            const uri = Uri.file(path.join(repo.path, fileName)).with({
                scheme: 'jj-view',
                query: `base=${ids.modified.changeId}&side=right`,
            });

            await squashSelectionIntoParentCommand(ctx, {
                uri,
                ranges: [{ startLine: 1, endLine: 1 }],
            });

            const parentContent = repo.getFileContent(ids.root.changeId, fileName);
            expect(parentContent).toBe('line1\nmodified2\nline3\n');
        });

        test('squashes selection and hunk when workspaceRoot is a symlink and uri uses realpath', async () => {
            using tempContainer = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-cmd-sym-'));
            const symlinkRoot = path.join(tempContainer.path, 'ws-link');
            using _wsLink = new ScopedSymlink(
                symlinkRoot,
                repo.path,
                process.platform === 'win32' ? 'junction' : 'dir',
            );

            const symlinkJj = new JjService(symlinkRoot, NO_OP_LOGGER);
            const symlinkRepo = createMock<JjRepository>({
                jj: symlinkJj,
                refresh: vi.fn().mockResolvedValue(undefined),
            });
            const symlinkCtx = new FakeCommandContext(symlinkRepo);

            const fileName = 'sym.txt';
            await buildGraph(repo, [
                { label: 'parent', files: { [fileName]: 'l1\nl2\nl3\nl4\nl5\n' } },
                {
                    label: 'wc',
                    parents: ['parent'],
                    files: { [fileName]: 'l1\nmod2\nl3\nmod4\nl5\n' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            const realFileUri = Uri.file(path.join(repo.path, fileName));
            await squashSelectionIntoParentCommand(symlinkCtx, {
                uri: realFileUri,
                ranges: [{ startLine: 1, endLine: 1 }],
            });
            expect(repo.getFileContent('@-', fileName)).toBe('l1\nmod2\nl3\nl4\nl5\n');

            await squashHunkIntoParentCommand(symlinkCtx, {
                uri: realFileUri,
                ranges: [{ startLine: 3, endLine: 3 }],
            });
            expect(repo.getFileContent('@-', fileName)).toBe('l1\nmod2\nl3\nmod4\nl5\n');
        });
    });
});
