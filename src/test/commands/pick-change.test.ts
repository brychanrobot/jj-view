/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { pickChangeCommand } from '../../core/commands/pick-change';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('pickChangeCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        ctx = new FakeCommandContext(createMock<JjRepository>({ jj, rootUri: Uri.file(repo.path) }));
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
});
