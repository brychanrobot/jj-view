/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { describePromptCommand } from '../../commands/describe-prompt';
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

describe('describePromptCommand', () => {
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

    test('prompts if input box is empty and sets description with user input', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';

        // Mock existing description
        repo.new(undefined, 'initial');
        await jj.describe('existing description', '@');

        // Mock user input
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('new description');

        await describePromptCommand(ctx, scmProvider);

        expect(vscode.window.showInputBox).toHaveBeenCalledWith({
            prompt: 'Set description',
            placeHolder: 'Description of the changes...',
            value: 'existing description',
        });

        // Check that describe happened
        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('new description');
    });

    test('does nothing if user cancels prompt', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';

        // Mock existing description
        await jj.describe('existing', '@');

        // Mock user cancellation
        vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

        await describePromptCommand(ctx, scmProvider);

        expect(vscode.window.showInputBox).toHaveBeenCalled();

        // The description of @ should still be 'existing' (no change)
        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('existing');
        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });

    test('shows prompt even when input box has text', async () => {
        repo.new(undefined, 'initial');
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = 'feat: quick describe';

        // Mock user accepting the pre-filled value
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('feat: quick describe updated');

        await describePromptCommand(ctx, scmProvider);

        // Prompt should be shown with the input box value
        expect(vscode.window.showInputBox).toHaveBeenCalledWith({
            prompt: 'Set description',
            placeHolder: 'Description of the changes...',
            value: 'feat: quick describe',
        });

        // Check that description was set
        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('feat: quick describe updated');
    });

    test('sets blank description when prompt is cleared', async () => {
        repo.new(undefined, 'initial');
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';

        // Mock existing description
        await jj.describe('existing description', '@');

        // Mock user clearing the prompt (empty string)
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('');

        await describePromptCommand(ctx, scmProvider);

        expect(vscode.window.showInputBox).toHaveBeenCalled();

        // The current working copy should have an empty description
        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');
    });

    test('handles errors during describe and displays error to user', async () => {
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('failing describe');
        vi.spyOn(jj, 'describe').mockRejectedValue(new Error('Describe failed'));

        await describePromptCommand(ctx, scmProvider);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Error setting description'),
            expect.anything(),
        );
    });
});
