/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    squashFilesIntoAncestorCommand,
    squashFilesIntoChildCommand,
    squashFilesIntoParentCommand,
} from '../../commands/squash-files';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('squash-files commands', () => {
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

    describe('squashFilesIntoParentCommand', () => {
        test('squashes specific file to parent', async () => {
            const fileName = 'file.txt';
            await buildGraph(repo, [
                {
                    label: 'root',
                    files: { 'root.txt': 'root' },
                },
                {
                    label: 'parent',
                    parents: ['root'],
                    description: 'parent',
                    files: { [fileName]: 'parent content', 'other.txt': 'other original' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'child content', 'other.txt': 'other modified' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            await squashFilesIntoParentCommand(ctx, { paths: [fileName] });

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('child content');

            const parentOther = repo.getFileContent('@-', 'other.txt');
            expect(parentOther).toBe('other original');
        });
    });

    describe('squashFilesIntoAncestorCommand', () => {
        test('squashes specific file into grandparent', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                { label: 'grandparent', description: 'grandparent', files: { [fileName]: 'grandparent content' } },
                {
                    label: 'parent',
                    parents: ['grandparent'],
                    description: 'parent',
                    files: { 'parent_file.txt': 'parent content' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'child content', 'other.txt': 'other content' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            ctx.host.ui.setNextRevisionPromptResponse(ids.grandparent.changeId);

            await squashFilesIntoAncestorCommand(ctx, { paths: [fileName] });

            const gpContent = repo.getFileContent(ids.grandparent.changeId, fileName);
            expect(gpContent).toBe('child content');

            const childOtherContent = repo.getFileContent('@', 'other.txt');
            expect(childOtherContent).toBe('other content');
        });
    });

    describe('squashFilesIntoChildCommand', () => {
        test('squashes file to single child', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'parent modified' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                },
            ]);

            await squashFilesIntoChildCommand(ctx, { paths: [fileName], revision: ids.parent.changeId });

            expect(repo.getFileContent(ids.child.changeId, fileName)).toBe('parent modified');
        });

        test('prompts when multiple children exist', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'parent modified' },
                },
                { label: 'child1', parents: ['parent'] },
                { label: 'child2', parents: ['parent'] },
            ]);

            ctx.host.ui.setNextRevisionPromptResponse(ids.child2.changeId);

            await squashFilesIntoChildCommand(ctx, { paths: [fileName], revision: ids.parent.changeId });

            expect(repo.getFileContent(ids.child2.changeId, fileName)).toBe('parent modified');
        });

        test('shows error when no children exist', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [{ label: 'only', description: 'only', files: { [fileName]: 'mod' } }]);

            await squashFilesIntoChildCommand(ctx, { paths: [fileName], revision: ids.only.changeId });

            expect(ctx.host.ui.errorMessages[0]).toContain('Squash Error');
        });
    });
});
