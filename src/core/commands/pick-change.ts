/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface PickChangePayload {
    /** Revset listing the changes to pick from. Defaults to `visible()`. */
    revset?: string;
}

/** Reads `revset` from the args object of a `${input:...}` variable of type `command`. */
export function parsePickChangePayload(args: unknown[]): PickChangePayload {
    const arg = args[0];
    if (typeof arg === 'object' && arg !== null && 'revset' in arg && typeof arg.revset === 'string') {
        return { revset: arg.revset };
    }
    return {};
}

/**
 * Prompts for a change and returns its ID (or a typed revset) without running any jj operation.
 * Meant for `${command:jj-view.pickChange}` in tasks and launch configurations; VS Code requires a
 * string result, so `undefined` (cancelled) leaves the variable unresolved.
 */
export async function pickChangeCommand(ctx: CommandContext, payload?: PickChangePayload): Promise<string | undefined> {
    const revisionQuery = payload?.revset?.trim() || RevisionQuery.visible();
    try {
        const revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
            placeHolder: 'Select a change',
            emptyPrompt: 'Enter change',
            revisionQuery,
            repoRoot: ctx.repo.rootUri,
            nav: ctx.host.nav,
            log: ctx.log,
            throwOnError: true,
        });
        return revision?.trim() || undefined;
    } catch (error: unknown) {
        await showJjError(
            ctx.host.ui,
            error,
            `Failed to list changes for revset "${revisionQuery}"`,
            ctx.repo.jj,
            ctx.log,
        );
        return undefined;
    }
}
