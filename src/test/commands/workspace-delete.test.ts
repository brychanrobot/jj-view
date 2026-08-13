/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { workspaceDeleteCommand } from '../../commands/workspace-delete';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showWarningMessage: vi.fn(),
            showQuickPick: vi.fn(),
            withProgress: vi.fn((_options, task) => task()),
        },
    });
});

describe('workspace delete command', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj, refresh: vi.fn() });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMockLogOutputChannel({ appendLine: vi.fn(), show: vi.fn(), error: vi.fn() }),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('prompts for workspace selection when payload is missing workspace name', async () => {
        const workspace = repo.workspaceAdd('feature');
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            label: 'feature',
            description: workspace.path,
        });
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);

        await workspaceDeleteCommand(ctx, {});

        expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ label: 'feature', description: workspace.path })]),
            {
                placeHolder: 'Select a workspace to operate on',
                title: 'Workspace Action',
            },
        );
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });

    test('prompts for workspace selection when payload has an empty string workspace name', async () => {
        const workspace = repo.workspaceAdd('feature');
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            label: 'feature',
            description: workspace.path,
        });
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);

        // This tests the truthiness check fix: payload.workspaceName = '' should fall back to resolveWorkspaceName
        await workspaceDeleteCommand(ctx, { workspaceName: '' });

        expect(vscode.window.showQuickPick).toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });

    test('does not prompt or delete if selection is cancelled when payload has empty string', async () => {
        repo.workspaceAdd('feature');
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

        await workspaceDeleteCommand(ctx, { workspaceName: '' });

        // Since quick pick returns undefined, the command should return early without warning or deleting.
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    test('deletes the workspace when confirmed', async () => {
        repo.workspaceAdd('feature');
        const YES = 'Yes, Delete Workspace';
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(YES as never);
        const refreshSpy = vi.spyOn(mockJjRepo, 'refresh').mockResolvedValue(undefined);
        const forgetSpy = vi.spyOn(jj, 'workspaceForget');

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('forget AND delete the directory for workspace "feature"'),
            { modal: true },
            YES,
        );
        expect(forgetSpy).toHaveBeenCalledWith('feature');
        expect(refreshSpy).toHaveBeenCalled();
    });

    test('does not delete the workspace when not confirmed', async () => {
        repo.workspaceAdd('feature');
        const YES = 'Yes, Delete Workspace';
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
        const refreshSpy = vi.spyOn(mockJjRepo, 'refresh').mockResolvedValue(undefined);
        const forgetSpy = vi.spyOn(jj, 'workspaceForget');

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('forget AND delete the directory for workspace "feature"'),
            { modal: true },
            YES,
        );
        expect(forgetSpy).not.toHaveBeenCalled();
        expect(refreshSpy).not.toHaveBeenCalled();
    });
});
