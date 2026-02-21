/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { commitPromptCommand } from '../../commands/commit-prompt';
import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { TestRepo } from '../test-repo';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    window: {
        showInformationMessage: vi.fn(),
        showInputBox: vi.fn(),
        withProgress: vi.fn().mockImplementation(async (_, task) => task()),
    },
    ProgressLocation: { Notification: 15 },
}));

describe('commitPromptCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
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

    test('prompts if input box is empty and commits with user input', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';
        
        // Mock existing description
        repo.new(undefined, 'initial');
        await jj.describe('existing description', '@');
        
        // Mock user input
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('new description');

        await commitPromptCommand(scmProvider, jj);

        expect(vscode.window.showInputBox).toHaveBeenCalledWith({
            prompt: 'Commit message',
            placeHolder: 'Description of the change...',
            value: 'existing description',
        });

        // Check that commit happened
        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('new description');
        
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Committed change');
    });

    test('does nothing if user cancels prompt', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';
        
        // Mock existing description
        await jj.describe('existing', '@');

        // Mock user cancellation
        vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

        await commitPromptCommand(scmProvider, jj);

        expect(vscode.window.showInputBox).toHaveBeenCalled();
        // Should NOT have committed
        // The description of @ should still be 'existing' (no new commit created)
        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('existing');
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    test('shows prompt even when input box has text', async () => {
        repo.new(undefined, 'initial');
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = 'feat: quick commit';
        
        // Mock user accepting the pre-filled value
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('feat: quick commit');

        await commitPromptCommand(scmProvider, jj);

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

        expect(scmProvider.sourceControl.inputBox.value).toBe('');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Committed change');
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

        await commitPromptCommand(scmProvider, jj);

        expect(vscode.window.showInputBox).toHaveBeenCalled();

        // Check that a new change was created (jj.new() was called)
        // The current change ID should be different from before
        const afterChangeId = repo.getChangeId('@');
        expect(afterChangeId).not.toBe(beforeChangeId);
        
        // The parent should still have the existing description
        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('');
        
        // The new working copy should have an empty description
        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');
        
        expect(scmProvider.sourceControl.inputBox.value).toBe('');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Committed change');
    });
});
