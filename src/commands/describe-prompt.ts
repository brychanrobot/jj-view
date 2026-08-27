/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import { showJjError } from '../common/ui-helpers';
import { maybeFormatDescriptionOnSave } from './command-utils';

export async function describePromptCommand(ctx: CommandContext): Promise<void> {
    try {
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

        const description = await maybeFormatDescriptionOnSave(input, ctx);
        await ctx.host.ui.withProgress('Setting description...', () => jj.describe(description));
        await ctx.repo.refresh({ reason: 'after describe' });
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Error setting description', ctx.repo.jj, ctx.log);
    }
}
