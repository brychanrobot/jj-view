/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deleteBookmarkCommand } from '../../commands/bookmark-delete';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('deleteBookmarkCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
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

    test('deletes specified bookmark directly from payload', async () => {
        repo.bookmark('feature-1', '@');
        expect(repo.getBookmarks('@')).toContain('feature-1');

        await deleteBookmarkCommand(ctx, { bookmarkName: 'feature-1' });

        expect(repo.getBookmarks('@')).not.toContain('feature-1');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after bookmark delete' });
        expect(ctx.host.ui.infoMessages[0]).toContain('Deleted bookmark "feature-1".');
    });

    test('prompts for bookmark when bookmarkName is omitted', async () => {
        repo.bookmark('feature-1', '@');
        repo.bookmark('feature-2', '@');

        ctx.host.ui.setNextQuickPickResponse({ label: 'feature-1', value: 'feature-1' });

        await deleteBookmarkCommand(ctx, {});

        expect(repo.getBookmarks('@')).not.toContain('feature-1');
        expect(repo.getBookmarks('@')).toContain('feature-2');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after bookmark delete' });
    });

    test('shows information message when no local bookmarks exist', async () => {
        await deleteBookmarkCommand(ctx, {});

        expect(ctx.host.ui.infoMessages[0]).toContain('No local bookmarks to delete.');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('does nothing if user cancels bookmark selection prompt', async () => {
        repo.bookmark('feature-1', '@');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await deleteBookmarkCommand(ctx, {});

        expect(repo.getBookmarks('@')).toContain('feature-1');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('handles errors during bookmark deletion and displays error', async () => {
        const brokenJj = new JjService(repo.path, NO_OP_LOGGER, { binaryPath: '/non/existent/jj' });
        const brokenRepo = createMock<JjRepository>({
            jj: brokenJj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        const brokenCtx = new FakeCommandContext(brokenRepo);

        await deleteBookmarkCommand(brokenCtx, { bookmarkName: 'feature-1' });

        expect(brokenCtx.host.ui.errorMessages).toHaveLength(1);
        expect(brokenCtx.host.ui.errorMessages[0]).toContain('Failed to delete bookmark');
    });
});
