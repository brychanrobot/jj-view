/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { viewFileAtRevisionCommand } from '../../commands/view-file-at-revision';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { createViewFileAtRevisionPayload } from '../../vscode/payloads/view-file-at-revision.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';
import { resetMockQuickPick, setActiveItems, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: { executeCommand: vi.fn() },
    });
});

describe('viewFileAtRevisionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockOutputChannel: vscode.LogOutputChannel;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj });
        mockOutputChannel = createMockLogOutputChannel({ appendLine: vi.fn(), show: vi.fn(), error: vi.fn() });
        ctx = new VSCodeCommandContext(mockJjRepo, mockOutputChannel, createMock<CommentsManager>({}));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('opens vscode.open with jj-view uri for target file and revision', async () => {
        repo.writeFile('file1.txt', 'content');
        const fileUri = Uri.file(`${repo.path}/file1.txt`);

        const mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);

        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
        setSelectedItems(mockQuickPick, [{ label: 'main', detail: 'main' }]);
        setActiveItems(mockQuickPick, [{ label: 'main', detail: 'main' }]);

        const payload = createViewFileAtRevisionPayload([fileUri]);
        await viewFileAtRevisionCommand(ctx, payload);

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find((c) => c[0] === 'vscode.open');
        expect(call).toBeDefined();
        if (call) {
            const targetUri = call[1] as Uri;
            expect(targetUri.scheme).toBe('jj-view');
            expect(targetUri.fragment).toContain('revision=main');
            expect(targetUri.path).toBe('/file1.txt');
        }
    });
});
