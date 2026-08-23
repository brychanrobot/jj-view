/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { describePromptCommand } from '../../commands/describe-prompt';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

describe('describePromptCommand', () => {
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

    test('prompts if input box is empty and sets description with user input', async () => {
        scmProvider.sourceControl.inputBox.value = '';

        repo.new(undefined, 'initial');
        await jj.describe('existing description', '@');

        ctx.host.ui.setNextInputBoxResponse('new description');

        await describePromptCommand(ctx, scmProvider);

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('new description');
    });

    test('does nothing if user cancels prompt', async () => {
        scmProvider.sourceControl.inputBox.value = '';

        await jj.describe('existing', '@');

        ctx.host.ui.setNextInputBoxResponse(undefined);

        await describePromptCommand(ctx, scmProvider);

        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('existing');
        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });

    test('shows prompt even when input box has text', async () => {
        repo.new(undefined, 'initial');
        scmProvider.sourceControl.inputBox.value = 'feat: quick describe';

        ctx.host.ui.setNextInputBoxResponse('feat: quick describe updated');

        await describePromptCommand(ctx, scmProvider);

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('feat: quick describe updated');
    });

    test('sets blank description when prompt is cleared', async () => {
        repo.new(undefined, 'initial');
        scmProvider.sourceControl.inputBox.value = '';

        await jj.describe('existing description', '@');

        ctx.host.ui.setNextInputBoxResponse('');

        await describePromptCommand(ctx, scmProvider);

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');
    });

    test('handles errors during describe and displays error to user', async () => {
        ctx.host.ui.setNextInputBoxResponse('failing describe');
        vi.spyOn(jj, 'describe').mockRejectedValue(new Error('Describe failed'));

        await describePromptCommand(ctx, scmProvider);

        expect(ctx.host.ui.errorMessages[0].prefix).toBe('Error setting description');
    });
});
