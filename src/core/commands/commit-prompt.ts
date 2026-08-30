/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';
import { maybeFormatDescriptionOnSave } from './command-utils';

export interface CommitPromptPayload {
    initialValue?: string;
}

export async function commitPromptCommand(ctx: CommandContext, payload?: CommitPromptPayload): Promise<void> {
    try {
        const { jj } = ctx.repo;
        const defaultValue = payload?.initialValue || (await jj.getDescription('@'));

        const input = await ctx.host.ui.showInputBox({
            prompt: 'Commit message',
            placeHolder: 'Description of the change...',
            value: defaultValue,
        });

        if (input === undefined) {
            return;
        }

        const message = await maybeFormatDescriptionOnSave(input, ctx);
        await ctx.host.ui.withProgress('Committing...', () => jj.commit(message));
        await ctx.repo.refresh({ reason: 'after commit' });
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Error committing change', ctx.repo.jj, ctx.log);
    }
}
