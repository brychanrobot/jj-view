/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { setBookmarkCommand } from '../../commands/bookmark';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
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
    let scmProvider: JjScmProvider;
    let mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({ refresh: vi.fn() });

        mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('fetches bookmarks and shows quick pick', async () => {
        repo.bookmark('feature-a', '@');

        await setBookmarkCommand(scmProvider, jj, { commitId: 'some-id' });

        expect(mockQuickPick.show).toHaveBeenCalled();
        expect(mockQuickPick.items).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'feature-a' })]));
    });

    test('sets bookmark when selected from list', async () => {
        repo.bookmark('feature-a', '@');

        let acceptCallback: () => Promise<void> = async () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb: () => Promise<void>) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });

        await setBookmarkCommand(scmProvider, jj, { commitId: repo.getChangeId('@') });

        setSelectedItems(mockQuickPick, [{ label: 'feature-a' }]);
        await acceptCallback();

        expect(mockQuickPick.hide).toHaveBeenCalled();
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('creates new bookmark when typed', async () => {
        let acceptCallback: () => Promise<void> = async () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb: () => Promise<void>) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });

        const commitId = repo.getChangeId('@');
        await setBookmarkCommand(scmProvider, jj, { commitId });

        setSelectedItems(mockQuickPick, []);
        mockQuickPick.value = 'new-feature';
        await acceptCallback();

        expect(mockQuickPick.hide).toHaveBeenCalled();

        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('new-feature');
    });
});
