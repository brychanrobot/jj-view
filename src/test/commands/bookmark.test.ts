/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { setBookmarkCommand } from '../../commands/bookmark';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createSetBookmarkPayload } from '../../vscode/payloads/bookmark.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { resetMockQuickPick, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('setBookmarkCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;
    let mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>;

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

        mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    const runSetBookmark = async (args: unknown[]) => {
        const payload = createSetBookmarkPayload(args);
        await setBookmarkCommand(ctx, payload);
    };

    test('fetches bookmarks and shows quick pick', async () => {
        repo.bookmark('feature-a', '@');

        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });

        await runSetBookmark([{ commitId: 'some-id' }]);

        expect(mockQuickPick.show).toHaveBeenCalled();
        expect(mockQuickPick.items).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'feature-a' })]));
    });

    test('sets bookmark when selected from list', async () => {
        repo.bookmark('feature-a', '@');

        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            setSelectedItems(mockQuickPick, [{ label: 'feature-a' }]);
            acceptCallback();
        });

        const commitId = repo.getChangeId('@');
        await runSetBookmark([{ commitId }]);

        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('feature-a');
    });

    test('creates new bookmark when typed', async () => {
        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            setSelectedItems(mockQuickPick, []);
            mockQuickPick.value = 'new-feature';
            acceptCallback();
        });

        const commitId = repo.getChangeId('@');
        await runSetBookmark([{ commitId }]);

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
        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            setSelectedItems(mockQuickPick, []);
            mockQuickPick.value = 'prompted-bookmark';
            acceptCallback();
        });

        const commitId = repo.getChangeId('@');
        await setBookmarkCommand(ctx, { revision: commitId, name: '   ' });

        expect(mockQuickPick.show).toHaveBeenCalled();
        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('prompted-bookmark');
    });
});
