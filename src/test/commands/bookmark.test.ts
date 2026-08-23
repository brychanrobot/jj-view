/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setBookmarkCommand } from '../../commands/bookmark';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('setBookmarkCommand', () => {
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

    test('sets bookmark when selected from list', async () => {
        repo.bookmark('feature-a', '@');

        ctx.host.ui.setNextSelectOrCreateResponse('feature-a');

        const commitId = repo.getChangeId('@');
        await setBookmarkCommand(ctx, { revision: commitId });

        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('feature-a');
    });

    test('creates new bookmark when typed', async () => {
        ctx.host.ui.setNextSelectOrCreateResponse('new-feature');

        const commitId = repo.getChangeId('@');
        await setBookmarkCommand(ctx, { revision: commitId });

        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('new-feature');
    });

    test('normalizes and trims bookmark name from payload', async () => {
        const commitId = repo.getChangeId('@');
        await setBookmarkCommand(ctx, { revision: commitId, name: '  trimmed-bookmark  ' });

        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('trimmed-bookmark');
    });

    test('prompts for bookmark when payload name is empty or whitespace', async () => {
        ctx.host.ui.setNextSelectOrCreateResponse('prompted-bookmark');

        const commitId = repo.getChangeId('@');
        await setBookmarkCommand(ctx, { revision: commitId, name: '   ' });

        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('prompted-bookmark');
    });
});
