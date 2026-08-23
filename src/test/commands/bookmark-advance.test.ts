/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { advanceBookmarkCommand } from '../../commands/bookmark-advance';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { createAdvanceBookmarkPayload } from '../../vscode/payloads/bookmark-advance.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
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

    const runAdvanceBookmark = async (args: unknown[]) => {
        const payload = createAdvanceBookmarkPayload(args);
        return await advanceBookmarkCommand(ctx, payload);
    };

    test('advances bookmark with revision argument directly', async () => {
        repo.bookmark('test-bookmark', '@');
        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        await runAdvanceBookmark([child.change_id]);

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
    });

    test('prompts for revision if not provided, and advances bookmark', async () => {
        repo.bookmark('test-bookmark', '@');
        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        ctx.host.ui.setNextRevisionPromptResponse(child.commit_id);

        await runAdvanceBookmark([]);

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
    });
});
