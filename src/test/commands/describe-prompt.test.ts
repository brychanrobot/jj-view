/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { describePromptCommand } from '../../core/commands/describe-prompt';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('describePromptCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj, refresh: vi.fn().mockResolvedValue(undefined) });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('prompts if payload is empty and sets description with user input', async () => {
        repo.new(undefined, 'initial');
        await jj.describe('existing description', '@');

        ctx.host.ui.setNextInputBoxResponse('new description');

        await describePromptCommand(ctx, { initialValue: '' });

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('new description');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after describe' });
    });

    test('does nothing if user cancels prompt', async () => {
        await jj.describe('existing', '@');

        ctx.host.ui.setNextInputBoxResponse(undefined);

        await describePromptCommand(ctx, { initialValue: '' });

        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('existing');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('shows prompt and pre-fills initialValue from payload', async () => {
        repo.new(undefined, 'initial');

        ctx.host.ui.setNextInputBoxResponse('feat: quick describe updated');

        await describePromptCommand(ctx, { initialValue: 'feat: quick describe' });

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('feat: quick describe updated');
    });

    test('sets blank description when prompt is cleared', async () => {
        repo.new(undefined, 'initial');

        await jj.describe('existing description', '@');

        ctx.host.ui.setNextInputBoxResponse('');

        await describePromptCommand(ctx);

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');
    });

    test('handles errors during describe and displays error to user', async () => {
        const brokenJj = new JjService(repo.path, NO_OP_LOGGER, { binaryPath: '/non/existent/jj' });
        const brokenRepo = createMock<JjRepository>({
            jj: brokenJj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        const brokenCtx = new FakeCommandContext(brokenRepo);
        brokenCtx.host.ui.setNextInputBoxResponse('failing describe');

        await describePromptCommand(brokenCtx);

        expect(brokenCtx.host.ui.errorMessages[0]).toContain('Error setting description');
    });
});
