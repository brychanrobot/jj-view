/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';
import type { JjScmProvider } from '../jj-scm-provider';
import { maybeFormatDescriptionOnSave } from './command-utils';

export async function commitPromptCommand(ctx: CommandContext, scmProvider?: JjScmProvider): Promise<void> {
    const { jj } = ctx.repo;
    const inputBoxValue = scmProvider?.sourceControl.inputBox.value;
    const defaultValue = inputBoxValue || (await jj.getDescription('@'));

    const input = await ctx.ui.showInputBox({
        prompt: 'Commit message',
        placeHolder: 'Description of the change...',
        value: defaultValue,
    });

    if (input === undefined) {
        return;
    }

    try {
        const message = await maybeFormatDescriptionOnSave(input, ctx);
        await ctx.ui.withProgress('Committing...', () => jj.commit(message));
        if (scmProvider) {
            await scmProvider.refresh({ reason: 'after commit' });
        } else {
            await ctx.repo.refresh();
        }
    } catch (err: unknown) {
        await ctx.ui.showError(err, 'Error committing change');
    }
}
