/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { advanceBookmarkCommand } from '../../core/commands/bookmark-advance';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('advanceBookmarkCommand', () => {
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

    test('advances bookmark with revision argument directly', async () => {
        repo.bookmark('test-bookmark', '@');
        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        await advanceBookmarkCommand(ctx, { revision: child.change_id });

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
    });

    test('prompts for revision if not provided, restricting to mutable ancestors, and advances bookmark', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'base.txt': 'base\n' } },
            { label: 'parent', parents: ['base'], files: { 'p.txt': 'p\n' } },
            { label: 'child', parents: ['parent'], files: { 'c.txt': 'c\n' }, isCurrentWorkingCopy: true },
        ]);
        repo.config('revset-aliases."immutable_heads()"', `commit_id("${ids.base.commitId}")`);
        repo.bookmark('test-bookmark', ids.parent.changeId);

        ctx.host.ui.setNextRevisionPromptResponse(ids.child.changeId);

        await advanceBookmarkCommand(ctx, {});

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );

        // Verify that prompt only presented mutable ancestors including @, not immutable base
        const quickPick = ctx.host.ui.quickPickCalls[0];
        const details = quickPick.items.map((i) => i.detail);
        expect(details).toContain(ids.child.changeId);
        expect(details).toContain(ids.parent.changeId);
        expect(details).not.toContain(ids.base.changeId);
    });
});
