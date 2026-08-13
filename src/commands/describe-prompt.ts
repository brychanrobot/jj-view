/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import type { JjScmProvider } from '../jj-scm-provider';
import { maybeFormatDescriptionOnSave } from './command-utils';

export async function describePromptCommand(ctx: CommandContext, scmProvider?: JjScmProvider): Promise<void> {
    const { jj } = ctx.repo;
    const inputBoxValue = scmProvider?.sourceControl.inputBox.value;
    const defaultValue = inputBoxValue || (await jj.getDescription('@'));

    const input = await ctx.ui.showInputBox({
        prompt: 'Set description',
        placeHolder: 'Description of the changes...',
        value: defaultValue,
    });

    if (input === undefined) {
        return;
    }

    try {
        const description = await maybeFormatDescriptionOnSave(input, ctx);
        await ctx.ui.withProgress('Setting description...', () => jj.describe(description));
        if (scmProvider) {
            await scmProvider.refresh({ reason: 'after describe' });
        } else {
            await ctx.repo.refresh();
        }
    } catch (err: unknown) {
        await ctx.ui.showError(err, 'Error setting description');
    }
}
