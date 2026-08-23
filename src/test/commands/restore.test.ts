/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { restoreCommand } from '../../commands/restore';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('restoreCommand', () => {
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

        await restoreCommand(ctx, { pathsByRevision: { '@': [fileName] } });

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

        await restoreCommand(ctx, { pathsByRevision: { [ids.ancestor.changeId]: [fileName] } });

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

        await restoreCommand(ctx, {
            pathsByRevision: {
                [ids.ancestor.changeId]: [file1],
                [ids.child.changeId]: [file2],
            },
        });

        const ancestorContent = repo.getFileContent(ids.ancestor.changeId, file1);
        expect(ancestorContent).toBe('original 1');

        const childContent = repo.getFileContent(ids.child.changeId, file2);
        expect(childContent).toBe('original 2');
    });
});
