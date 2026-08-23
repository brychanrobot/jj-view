/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { squashHunkIntoParentCommand, squashSelectionIntoParentCommand } from '../../commands/squash-selection';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
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

    afterEach(() => {
        vi.clearAllMocks();
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
    });
});
