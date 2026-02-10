/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { commitCommand } from '../../commands/commit';
import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { TestRepo } from '../test-repo';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('commitCommand', () => {
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

    test('shows warning if input box is empty', async () => {
        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = '';
        await commitCommand(scmProvider, jj);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Please provide a commit message');
        const desc = repo.getDescription('@');
        expect(desc).toBe('');
    });

    test('commits change successfully', async () => {
        repo.new(undefined, 'initial');
        const initialId = repo.getChangeId('@');

        const inputBoxMock = scmProvider.sourceControl.inputBox;
        inputBoxMock.value = 'feat: my change';
        await commitCommand(scmProvider, jj);

        const oldChangeDesc = repo.getDescription(initialId);
        expect(oldChangeDesc.trim()).toBe('feat: my change');

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');

        expect(scmProvider.sourceControl.inputBox.value).toBe('');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Committed change');
        expect(scmProvider.refresh).toHaveBeenCalled();
    });
});
