/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { restoreCommand } from '../../commands/restore';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createRestorePayload } from '../../vscode/payloads/restore.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('restoreCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    const runRestore = async (args: unknown[]) => {
        const payload = createRestorePayload(args);
        await restoreCommand(ctx, payload);
    };

    test('restores file content', async () => {
        const fileName = 'restore.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'original' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { [fileName]: 'modified' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await runRestore(args);

        const content = fs.readFileSync(path.join(repo.path, fileName), 'utf-8');
        expect(content).toBe('original');
    });

    test('restores file content on mutable non-working copy commit', async () => {
        const fileName = 'restore_non_wc.txt';
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'original' } },
            {
                label: 'ancestor',
                parents: ['parent'],
                description: 'ancestor',
                files: { [fileName]: 'modified' },
            },
            {
                label: 'child',
                parents: ['ancestor'],
                description: 'child',
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri, revision: ids.ancestor.changeId }];

        await runRestore(args);

        const ancestorContent = repo.getFileContent(ids.ancestor.changeId, fileName);
        expect(ancestorContent).toBe('original');
    });

    test('restores files across multiple revisions', async () => {
        const file1 = 'file1.txt';
        const file2 = 'file2.txt';
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [file1]: 'original 1', [file2]: 'original 2' } },
            {
                label: 'ancestor',
                parents: ['parent'],
                description: 'ancestor',
                files: { [file1]: 'modified 1' },
            },
            {
                label: 'child',
                parents: ['ancestor'],
                description: 'child',
                files: { [file2]: 'modified 2' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const file1Uri = Uri.file(path.join(repo.path, file1));
        const file2Uri = Uri.file(path.join(repo.path, file2));
        const args = [
            { resourceUri: file1Uri, revision: ids.ancestor.changeId },
            { resourceUri: file2Uri, revision: ids.child.changeId },
        ];

        await runRestore(args);

        const ancestorContent = repo.getFileContent(ids.ancestor.changeId, file1);
        expect(ancestorContent).toBe('original 1');

        const childContent = repo.getFileContent(ids.child.changeId, file2);
        expect(childContent).toBe('original 2');
    });
});
