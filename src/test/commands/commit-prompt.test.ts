/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { commitPromptCommand } from '../../commands/commit-prompt';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';

import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('commitPromptCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj, refresh: vi.fn().mockResolvedValue(undefined) });
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn().mockResolvedValue(undefined),
            outputChannel: createMockLogOutputChannel({
                appendLine: vi.fn(),
            }),
            sourceControl: createMock<vscode.SourceControl>({
                inputBox: createMock<vscode.SourceControlInputBox>({
                    value: '',
                }),
            }),
        });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMockLogOutputChannel({ appendLine: vi.fn(), show: vi.fn(), error: vi.fn() }),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('prompts if input box is empty and commits with user input', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';

        // Mock existing description
        repo.new(undefined, 'initial');
        await jj.describe('existing description', '@');

        // Mock user input
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('new description');

        await commitPromptCommand(ctx, scmProvider);

        expect(vscode.window.showInputBox).toHaveBeenCalledWith({
            prompt: 'Commit message',
            placeHolder: 'Description of the change...',
            value: 'existing description',
        });

        // Check that commit happened
        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('new description');

        // Success path should refresh SCM state
        expect(scmProvider.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('does nothing if user cancels prompt', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';

        // Mock existing description
        await jj.describe('existing', '@');

        // Mock user cancellation
        vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

        await commitPromptCommand(ctx, scmProvider);

        expect(vscode.window.showInputBox).toHaveBeenCalled();
        // Should NOT have committed
        // The description of @ should still be 'existing' (no new commit created)
        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('existing');

        // Cancel path should not refresh
        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });

    test('shows prompt even when input box has text', async () => {
        repo.new(undefined, 'initial');
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = 'feat: quick commit';

        // Mock user accepting the pre-filled value
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('feat: quick commit');

        await commitPromptCommand(ctx, scmProvider);

        // Prompt should be shown with the input box value
        expect(vscode.window.showInputBox).toHaveBeenCalledWith({
            prompt: 'Commit message',
            placeHolder: 'Description of the change...',
            value: 'feat: quick commit',
        });

        // Check that commit happened
        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('feat: quick commit');

        // Success path should refresh SCM state
        expect(scmProvider.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('commits with blank message when prompt is cleared', async () => {
        repo.new(undefined, 'initial');
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';

        // Mock existing description
        await jj.describe('existing description', '@');

        // Get the current change ID before the operation
        const beforeChangeId = repo.getChangeId('@');

        // Mock user clearing the prompt (empty string)
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('');

        await commitPromptCommand(ctx, scmProvider);

        expect(vscode.window.showInputBox).toHaveBeenCalled();

        // Check that a new change was created (commit happened)
        // The current change ID should be different from before
        const afterChangeId = repo.getChangeId('@');
        expect(afterChangeId).not.toBe(beforeChangeId);

        // Parent commit should have a blank description (commit message was cleared)
        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('');

        // The new working copy should have an empty description
        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');

        // Success path should refresh SCM state
        expect(scmProvider.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('handles errors during commit and displays error to user', async () => {
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('failing commit');
        vi.spyOn(jj, 'commit').mockRejectedValue(new Error('Commit failed'));

        await commitPromptCommand(ctx, scmProvider);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Error committing change'),
            expect.anything(),
        );
    });
});
