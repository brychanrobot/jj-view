/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { maybeFormatDescriptionOnSave } from './command-utils';

export async function describePromptCommand(ctx: CommandContext): Promise<void> {
    const { jj } = ctx.repo;
    const inputBoxValue = ctx.host.ui.getScmDescriptionInputValue?.();
    const defaultValue = inputBoxValue || (await jj.getDescription('@'));

    const input = await ctx.host.ui.showInputBox({
        prompt: 'Set description',
        placeHolder: 'Description of the changes...',
        value: defaultValue,
    });

    if (input === undefined) {
        return;
    }

    try {
        const description = await maybeFormatDescriptionOnSave(input, ctx);
        await ctx.host.ui.withProgress('Setting description...', () => jj.describe(description));
        await ctx.repo.refresh({ reason: 'after describe' });
    } catch (err: unknown) {
        await ctx.host.ui.showError(err, 'Error setting description');
    }
}
