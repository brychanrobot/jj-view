/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { advanceBookmarkCommand } from '../../commands/bookmark-advance';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createAdvanceBookmarkPayload } from '../../vscode/payloads/bookmark-advance.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { resetMockQuickPick, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('advanceBookmarkCommand', () => {
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

        let acceptCallback: () => Promise<void> = async () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb: () => Promise<void>) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            setSelectedItems(mockQuickPick, [{ label: child.commit_id, detail: child.commit_id }]);
            acceptCallback();
        });

        await runAdvanceBookmark([]);

        const [childLog] = await jj.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
    });
});
