/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { compareFileWithRevisionCommand } from '../../commands/compare-file-with-revision';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: { executeCommand: vi.fn() },
        window: {
            showInformationMessage: vi.fn(),
            showErrorMessage: vi.fn(),
            showInputBox: vi.fn(),
            showQuickPick: vi.fn(),
        },
    });
});

describe('compareFileWithRevisionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockOutputChannel: vscode.OutputChannel;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    it('opens vscode.diff comparing right clicked file', async () => {
        repo.writeFile('file1.txt', 'content');
        const fileUri = vscode.Uri.file(`${repo.path}/file1.txt`);

        let acceptCallback: () => void = () => {};
        const mockQuickPick = {
            items: [],
            selectedItems: [{ label: 'main', detail: 'main' }],
            activeItems: [{ label: 'main', detail: 'main' }],
            onDidChangeValue: vi.fn(),
            onDidAccept: vi.fn().mockImplementation((cb) => {
                acceptCallback = cb;
            }),
            onDidHide: vi.fn(),
            show: vi.fn().mockImplementation(() => {
                acceptCallback();
            }),
            dispose: vi.fn(),
        };
        vi.mocked(vscode.window.createQuickPick).mockReturnValue(
            createMock<vscode.QuickPick<vscode.QuickPickItem>>(mockQuickPick),
        );

        await compareFileWithRevisionCommand(jj, mockOutputChannel, fileUri);

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find((c) => c[0] === 'vscode.diff');
        const simplifiedCall = call
            ? [
                  call[0],
                  {
                      scheme: (call[1] as vscode.Uri).scheme,
                      query: (call[1] as vscode.Uri).query,
                  },
                  call[2],
                  call[3],
              ]
            : null;

        expect(simplifiedCall).toEqual([
            'vscode.diff',
            {
                scheme: 'jj-view',
                query: 'revision=main',
            },
            fileUri,
            'file1.txt (main ↔ Working Copy)',
        ]);
    });
});
