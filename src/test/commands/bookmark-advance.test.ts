/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { advanceBookmarkCommand } from '../../commands/bookmark-advance';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';
import { resetMockQuickPick, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('advanceBookmarkCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;
    let mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            outputChannel: createMockLogOutputChannel({ appendLine: vi.fn() }),
        });

        mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('advances bookmark with revision argument directly', async () => {
        repo.bookmark('test-bookmark', '@');
        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        await advanceBookmarkCommand(scmProvider, jj, [child.change_id]);

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('prompts for revision if not provided, and advances bookmark', async () => {
        repo.bookmark('test-bookmark', '@');
        await jj.new({ message: 'child' });
        const [child] = await jj.getLog({ revision: '@' });

        let acceptCallback: () => Promise<void> = async () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb: () => Promise<void>) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            setSelectedItems(mockQuickPick, [{ label: child.commit_id, detail: child.commit_id }]);
            acceptCallback();
        });

        await advanceBookmarkCommand(scmProvider, jj, []);

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
        expect(scmProvider.refresh).toHaveBeenCalled();
    });
});
