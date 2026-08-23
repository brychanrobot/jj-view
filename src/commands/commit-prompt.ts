/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { maybeFormatDescriptionOnSave } from './command-utils';

export async function commitPromptCommand(ctx: CommandContext): Promise<void> {
    const { jj } = ctx.repo;
    const inputBoxValue = ctx.host.ui.getScmDescriptionInputValue?.();
    const defaultValue = inputBoxValue || (await jj.getDescription('@'));

    const input = await ctx.host.ui.showInputBox({
        prompt: 'Commit message',
        placeHolder: 'Description of the change...',
        value: defaultValue,
    });

    if (input === undefined) {
        return;
    }

    try {
        const message = await maybeFormatDescriptionOnSave(input, ctx);
        await ctx.host.ui.withProgress('Committing...', () => jj.commit(message));
        await ctx.repo.refresh({ reason: 'after commit' });
    } catch (err: unknown) {
        await ctx.host.ui.showError(err, 'Error committing change');
    }
}
