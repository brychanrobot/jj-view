/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { setBookmarkCommand } from '../../commands/bookmark';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';

// Mock QuickPick
const { mockQuickPick } = vi.hoisted(() => ({
    mockQuickPick: {
        show: vi.fn(),
        hide: vi.fn(),
        onDidAccept: vi.fn(),
        selectedItems: [] as { label: string; description?: string }[],
        value: '',
        items: [] as { label: string; description?: string }[],
        placeholder: '',
        matchOnDescription: false,
    }
}));

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: { createQuickPick: vi.fn(() => mockQuickPick) },
    });
});

describe('setBookmarkCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({ refresh: vi.fn() });
        
        mockQuickPick.show.mockClear();
        mockQuickPick.hide.mockClear();
        mockQuickPick.onDidAccept.mockClear();
        mockQuickPick.selectedItems = [];
        mockQuickPick.value = '';
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('fetches bookmarks and shows quick pick', async () => {
        repo.bookmark('feature-a', '@');
        
        await setBookmarkCommand(scmProvider, jj, { commitId: 'some-id' });
        
        expect(mockQuickPick.show).toHaveBeenCalled();
        expect(mockQuickPick.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ label: 'feature-a' })
        ]));
    });

    test('sets bookmark when selected from list', async () => {
        repo.bookmark('feature-a', '@');
        
        let acceptCallback: () => Promise<void> = async () => {};
        mockQuickPick.onDidAccept.mockImplementation((cb: () => Promise<void>) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });

        await setBookmarkCommand(scmProvider, jj, { commitId: repo.getChangeId('@') });

        mockQuickPick.selectedItems = [{ label: 'feature-a' }];
        await acceptCallback();
        
        expect(mockQuickPick.hide).toHaveBeenCalled();
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('creates new bookmark when typed', async () => {
        let acceptCallback: () => Promise<void> = async () => {};
        mockQuickPick.onDidAccept.mockImplementation((cb: () => Promise<void>) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });

        const commitId = repo.getChangeId('@');
        await setBookmarkCommand(scmProvider, jj, { commitId });

        mockQuickPick.selectedItems = [];
        mockQuickPick.value = 'new-feature';
        await acceptCallback();
        
        expect(mockQuickPick.hide).toHaveBeenCalled();
        
        const bookmarks = repo.getBookmarks('@');
        expect(bookmarks).toContain('new-feature');
    });
});
