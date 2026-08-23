/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { commitPromptCommand } from '../../commands/commit-prompt';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

describe('commitPromptCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

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
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('prompts if input box is empty and commits with user input', async () => {
        scmProvider.sourceControl.inputBox.value = '';

        repo.new(undefined, 'initial');
        await jj.describe('existing description', '@');

        ctx.host.ui.setNextInputBoxResponse('new description');

        await commitPromptCommand(ctx, scmProvider);

        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('new description');

        expect(scmProvider.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('does nothing if user cancels prompt', async () => {
        scmProvider.sourceControl.inputBox.value = '';

        await jj.describe('existing', '@');

        ctx.host.ui.setNextInputBoxResponse(undefined);

        await commitPromptCommand(ctx, scmProvider);

        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('existing');

        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });

    test('shows prompt even when input box has text', async () => {
        repo.new(undefined, 'initial');
        scmProvider.sourceControl.inputBox.value = 'feat: quick commit';

        ctx.host.ui.setNextInputBoxResponse('feat: quick commit');

        await commitPromptCommand(ctx, scmProvider);

        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('feat: quick commit');

        expect(scmProvider.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('commits with blank message when prompt is cleared', async () => {
        repo.new(undefined, 'initial');
        scmProvider.sourceControl.inputBox.value = '';

        await jj.describe('existing description', '@');

        const beforeChangeId = repo.getChangeId('@');

        ctx.host.ui.setNextInputBoxResponse('');

        await commitPromptCommand(ctx, scmProvider);

        const afterChangeId = repo.getChangeId('@');
        expect(afterChangeId).not.toBe(beforeChangeId);

        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('');

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');

        expect(scmProvider.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('handles errors during commit and displays error to user', async () => {
        ctx.host.ui.setNextInputBoxResponse('failing commit');
        vi.spyOn(jj, 'commit').mockRejectedValue(new Error('Commit failed'));

        await commitPromptCommand(ctx, scmProvider);

        expect(ctx.host.ui.errorMessages[0].prefix).toBe('Error committing change');
    });
});
