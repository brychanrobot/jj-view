/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { describePromptCommand } from '../../commands/describe-prompt';
import { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('describePromptCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            outputChannel: createMock<vscode.OutputChannel>({
                appendLine: vi.fn(),
            }),
            sourceControl: createMock<vscode.SourceControl>({
                inputBox: createMock<vscode.SourceControlInputBox>({
                    value: '',
                }),
            }),
        });
    });

    afterEach(() => {
        repo.dispose();
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

        await describePromptCommand(scmProvider, jj);

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

        await describePromptCommand(scmProvider, jj);

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

        await describePromptCommand(scmProvider, jj);

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

        await describePromptCommand(scmProvider, jj);

        expect(vscode.window.showInputBox).toHaveBeenCalled();

        // The current working copy should have an empty description
        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');
    });
});
