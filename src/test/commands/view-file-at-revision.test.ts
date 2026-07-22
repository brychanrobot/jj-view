/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { viewFileAtRevisionCommand } from '../../commands/view-file-at-revision';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { resetMockQuickPick, setActiveItems, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: { executeCommand: vi.fn() },
    });
});

import { createMockLogOutputChannel } from '../test-utils';

describe('viewFileAtRevisionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockOutputChannel: vscode.LogOutputChannel;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockOutputChannel = createMockLogOutputChannel();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('opens vscode.open with jj-view uri for target file and revision', async () => {
        repo.writeFile('file1.txt', 'content');
        const fileUri = vscode.Uri.file(`${repo.path}/file1.txt`);

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

        await viewFileAtRevisionCommand(jj, mockOutputChannel, fileUri);

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find((c) => c[0] === 'vscode.open');
        expect(call).toBeDefined();
        if (call) {
            const targetUri = call[1] as vscode.Uri;
            expect(targetUri.scheme).toBe('jj-view');
            expect(targetUri.query).toBe('revision=main');
            expect(targetUri.fsPath).toBe(fileUri.fsPath);
        }
    });
});
