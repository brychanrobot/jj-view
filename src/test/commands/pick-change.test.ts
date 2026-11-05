/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { pickChangeCommand } from '../../core/commands/pick-change';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

describe('pickChangeCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let ctx: FakeCommandContext;
    let log: ReturnType<typeof createMockLogOutputChannel>;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        log = createMockLogOutputChannel();
        ctx = new FakeCommandContext(createMock<JjRepository>({ jj, rootUri: Uri.file(repo.path) }), undefined, log);
    });

    test('returns the picked change id', async () => {
        const { changeId } = repo.new(undefined, 'picked');
        ctx.host.ui.setNextRevisionPromptResponse(changeId);

        expect(await pickChangeCommand(ctx)).toBe(changeId);
    });

    test('returns undefined when the prompt is cancelled', async () => {
        ctx.host.ui.setNextRevisionPromptResponse(undefined);

        expect(await pickChangeCommand(ctx)).toBeUndefined();
    });

    test('returns undefined for a blank custom value', async () => {
        ctx.host.ui.setNextRevisionPromptResponse('   ');

        expect(await pickChangeCommand(ctx)).toBeUndefined();
    });

    test('offers visible changes in the prompt', async () => {
        const { changeId } = repo.new(undefined, 'listed');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await pickChangeCommand(ctx);

        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        const values = ctx.host.ui.quickPickCalls[0].items.map((item) => String(item.value));
        expect(values.some((value) => value.startsWith(changeId))).toBe(true);
    });

    test('lists only changes matching the given revset', async () => {
        repo.new(undefined, 'other');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await pickChangeCommand(ctx, { revset: 'root()' });

        expect(ctx.host.ui.quickPickCalls[0].items).toHaveLength(1);
    });

    test('falls back to visible() for a blank revset', async () => {
        const { changeId } = repo.new(undefined, 'listed');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await pickChangeCommand(ctx, { revset: '  ' });

        const values = ctx.host.ui.quickPickCalls[0].items.map((item) => String(item.value));
        expect(values.some((value) => value.startsWith(changeId))).toBe(true);
    });

    test('falls back to descriptive input box when revset matches zero changes', async () => {
        const showInputBoxSpy = vi.spyOn(ctx.host.ui, 'showInputBox');
        ctx.host.ui.setNextInputBoxResponse('  @-  ');

        const result = await pickChangeCommand(ctx, { revset: 'none()' });

        expect(result).toBe('@-');
        expect(ctx.host.ui.quickPickCalls).toHaveLength(0);
        expect(showInputBoxSpy).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'Enter change (no matching revisions)' }),
        );
    });

    test('returns undefined when fallback input box for empty revset is blank or cancelled', async () => {
        ctx.host.ui.setNextInputBoxResponse('   ');
        expect(await pickChangeCommand(ctx, { revset: 'none()' })).toBeUndefined();

        ctx.host.ui.setNextInputBoxResponse(undefined);
        expect(await pickChangeCommand(ctx, { revset: 'none()' })).toBeUndefined();
    });

    test('surfaces revset errors and returns undefined without falling back to input box', async () => {
        const showInputBoxSpy = vi.spyOn(ctx.host.ui, 'showInputBox');

        const result = await pickChangeCommand(ctx, { revset: 'invalid(' });

        expect(result).toBeUndefined();
        expect(ctx.host.ui.quickPickCalls).toHaveLength(0);
        expect(showInputBoxSpy).not.toHaveBeenCalled();
        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to list changes for revset "invalid("');
        expect(log.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to list changes for revset "invalid("'),
            expect.any(Error),
        );
    });

    test('returns full divergent change id with offset when picking a divergent change', async () => {
        repo.describe('v1');
        const v1CommitId = repo.getCommitId('@');
        repo.describe('v2');
        repo.bookmark('old', v1CommitId);

        let pickedValue: string | undefined;
        vi.spyOn(ctx.host.ui, 'showQuickPick').mockImplementation(async (items) => {
            pickedValue = String(items[0].value);
            return items[0];
        });

        const result = await pickChangeCommand(ctx, { revset: 'all() ~ root()' });

        expect(result).toBe(pickedValue);
        expect(result).toContain('/');
    });

    test('trims custom value accepted from quick pick', async () => {
        repo.new(undefined, 'candidate');
        ctx.host.ui.setNextQuickPickResponse({ label: '  main  ', customValue: '  main  ' });

        expect(await pickChangeCommand(ctx)).toBe('main');
    });
});
