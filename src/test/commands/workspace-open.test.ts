/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { workspaceOpenInCurrentWindowCommand, workspaceOpenInNewWindowCommand } from '../../commands/workspace-open';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import {
    createWorkspaceOpenInCurrentWindowPayload,
    createWorkspaceOpenInNewWindowPayload,
} from '../../vscode/payloads/workspace-open.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
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
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMockLogOutputChannel({ appendLine: vi.fn(), show: vi.fn(), error: vi.fn() }),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('opens the workspace from a context-menu argument in the current window', async () => {
        const workspace = repo.workspaceAdd('feature');

        const payload = createWorkspaceOpenInCurrentWindowPayload([{ workspaceName: 'feature' }]);
        await workspaceOpenInCurrentWindowCommand(ctx, payload);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openFolder',
            expect.objectContaining({ fsPath: Uri.file(workspace.path).fsPath }),
            { forceNewWindow: false },
        );
    });

    test('opens the selected workspace in a new window', async () => {
        const workspace = repo.workspaceAdd('feature');

        const payload = createWorkspaceOpenInNewWindowPayload([{ workspaceName: 'feature' }]);
        await workspaceOpenInNewWindowCommand(ctx, payload);

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

        const payload = createWorkspaceOpenInCurrentWindowPayload([]);
        await workspaceOpenInCurrentWindowCommand(ctx, payload);

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

        const payload = createWorkspaceOpenInCurrentWindowPayload([]);
        await workspaceOpenInCurrentWindowCommand(ctx, payload);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    test('reports an error when the workspace root cannot be resolved', async () => {
        const payload = createWorkspaceOpenInCurrentWindowPayload([{ workspaceName: 'missing' }]);
        await workspaceOpenInCurrentWindowCommand(ctx, payload);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Failed to open workspace "missing"'),
            'Show Log',
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('reports an error when workspace names cannot be resolved', async () => {
        repo.dispose();

        const payload = createWorkspaceOpenInCurrentWindowPayload([]);
        await workspaceOpenInCurrentWindowCommand(ctx, payload);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Failed to resolve workspace'),
            'Show Log',
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});
