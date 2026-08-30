/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { commitPromptCommand } from '../../core/commands/commit-prompt';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('commitPromptCommand', () => {
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

    test('prompts if payload is empty and commits with user input', async () => {
        repo.new(undefined, 'initial');
        await jj.describe('existing description', '@');

        ctx.host.ui.setNextInputBoxResponse('new description');

        await commitPromptCommand(ctx, { initialValue: '' });

        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('new description');

        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('does nothing if user cancels prompt', async () => {
        await jj.describe('existing', '@');

        ctx.host.ui.setNextInputBoxResponse(undefined);

        await commitPromptCommand(ctx, { initialValue: '' });

        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('existing');

        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('shows prompt and pre-fills initialValue from payload', async () => {
        repo.new(undefined, 'initial');

        ctx.host.ui.setNextInputBoxResponse('feat: quick commit');

        await commitPromptCommand(ctx, { initialValue: 'feat: quick commit' });

        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('feat: quick commit');

        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('commits with blank message when prompt is cleared', async () => {
        repo.new(undefined, 'initial');

        await jj.describe('existing description', '@');

        const beforeChangeId = repo.getChangeId('@');

        ctx.host.ui.setNextInputBoxResponse('');

        await commitPromptCommand(ctx);

        const afterChangeId = repo.getChangeId('@');
        expect(afterChangeId).not.toBe(beforeChangeId);

        const parentId = repo.getParents('@')[0];
        const parentDesc = repo.getDescription(parentId);
        expect(parentDesc.trim()).toBe('');

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');

        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('handles errors during commit and displays error to user', async () => {
        const brokenJj = new JjService(repo.path, NO_OP_LOGGER, { binaryPath: '/non/existent/jj' });
        const brokenRepo = createMock<JjRepository>({
            jj: brokenJj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        const brokenCtx = new FakeCommandContext(brokenRepo);
        brokenCtx.host.ui.setNextInputBoxResponse('failing commit');

        await commitPromptCommand(brokenCtx);

        expect(brokenCtx.host.ui.errorMessages[0]).toContain('Error committing change');
    });
});
