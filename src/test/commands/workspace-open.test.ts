/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { workspaceOpenInCurrentWindowCommand, workspaceOpenInNewWindowCommand } from '../../commands/workspace-open';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: {
            executeCommand: vi.fn(),
        },
        window: {
            showErrorMessage: vi.fn(),
            showQuickPick: vi.fn(),
        },
    });
});

describe('workspace open commands', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        scmProvider = createMock<JjScmProvider>({
            outputChannel: createMockLogOutputChannel({
                error: vi.fn(),
            }),
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('opens the workspace from a context-menu argument in the current window', async () => {
        const workspace = repo.workspaceAdd('feature');

        await workspaceOpenInCurrentWindowCommand(scmProvider, jj, [{ workspaceName: 'feature' }]);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openFolder',
            expect.objectContaining({ fsPath: Uri.file(workspace.path).fsPath }),
            { forceNewWindow: false },
        );
    });

    test('opens the selected workspace in a new window', async () => {
        const workspace = repo.workspaceAdd('feature');

        await workspaceOpenInNewWindowCommand(scmProvider, jj, [{ workspaceName: 'feature' }]);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openFolder',
            expect.objectContaining({ fsPath: Uri.file(workspace.path).fsPath }),
            { forceNewWindow: true },
        );
    });

    test('opens the workspace selected from the QuickPick', async () => {
        const workspace = repo.workspaceAdd('feature');
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            label: 'feature',
            description: workspace.path,
        });

        await workspaceOpenInCurrentWindowCommand(scmProvider, jj, []);

        expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ label: 'feature', description: workspace.path })]),
            {
                placeHolder: 'Select a workspace to operate on',
                title: 'Workspace Action',
            },
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openFolder',
            expect.objectContaining({ fsPath: Uri.file(workspace.path).fsPath }),
            { forceNewWindow: false },
        );
    });

    test('does nothing when workspace selection is cancelled', async () => {
        repo.workspaceAdd('feature');
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

        await workspaceOpenInCurrentWindowCommand(scmProvider, jj, []);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    test('reports an error when the workspace root cannot be resolved', async () => {
        await workspaceOpenInCurrentWindowCommand(scmProvider, jj, [{ workspaceName: 'missing' }]);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Failed to open workspace "missing"'),
            'Show Log',
        );
        expect(scmProvider.outputChannel.error).toHaveBeenCalledWith(
            expect.stringContaining('[Error] Failed to open workspace "missing"'),
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('reports an error when workspace names cannot be resolved', async () => {
        repo.dispose();

        await workspaceOpenInCurrentWindowCommand(scmProvider, jj, []);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Failed to resolve workspace'),
            'Show Log',
        );
        expect(scmProvider.outputChannel.error).toHaveBeenCalledWith(
            expect.stringContaining('[Error] Failed to resolve workspace'),
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});
