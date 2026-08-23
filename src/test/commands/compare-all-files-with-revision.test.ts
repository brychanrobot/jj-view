/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareAllFilesWithRevisionCommand } from '../../commands/compare-all-files-with-revision';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { createCompareAllFilesWithRevisionPayload } from '../../vscode/payloads/compare-all-files-with-revision.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('compareAllFilesWithRevisionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('opens vscode.changes with expected file list', async () => {
        const ids = await buildGraph(repo, [
            { label: 'v1', files: { 'file1.txt': 'v1\n', 'file2.txt': 'v1\n' } },
            { label: 'v2', parents: ['v1'], files: { 'file1.txt': 'v2\n' } },
        ]);
        const parentId = ids.v1.changeId;

        // Working copy changes
        repo.writeFile('file1.txt', 'wc\n');
        repo.deleteFile('file2.txt');
        repo.writeFile('file3.txt', 'unique added file\n');

        const payload = createCompareAllFilesWithRevisionPayload([parentId]);
        await compareAllFilesWithRevisionCommand(ctx, payload);

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const multiDiff = ctx.host.nav.multiDiffsOpened[0];
        expect(multiDiff.title).toContain('Compare');

        const simplified = multiDiff.resources.map((t) => ({
            path: path.basename(t.rightUri.fsPath),
            leftScheme: t.leftUri.scheme,
            leftFragment: t.leftUri.fragment,
            rightScheme: t.rightUri.scheme,
            rightFragment: t.rightUri.fragment,
        }));
        simplified.sort((a, b) => a.path.localeCompare(b.path));

        expect(simplified[0].leftScheme).toBe('jj-view');
        expect(simplified[0].leftFragment).toContain(`revision=${parentId}`);
        expect(simplified[0].rightScheme).toBe('file');

        expect(simplified[1].leftScheme).toBe('jj-view');
        expect(simplified[1].leftFragment).toContain(`revision=${parentId}`);
        expect(simplified[1].rightScheme).toBe('jj-view');
        expect(simplified[1].rightFragment).toContain('revision=none');

        expect(simplified[2].leftScheme).toBe('jj-view');
        expect(simplified[2].leftFragment).toContain('revision=none');
        expect(simplified[2].rightScheme).toBe('file');
    });

    it('shows info message when no differences are found', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file1.txt': 'v1\n' } }]);
        const parentId = ids.v1.changeId;

        const payload = createCompareAllFilesWithRevisionPayload([parentId]);
        await compareAllFilesWithRevisionCommand(ctx, payload);

        expect(ctx.host.ui.infoMessages).toContain(`No differences found between ${parentId} and working copy.`);
        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(0);
    });
});
