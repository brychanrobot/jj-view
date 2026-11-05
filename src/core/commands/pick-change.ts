/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface PickChangePayload {
    /** Revset listing the changes to pick from. Defaults to `visible()`. */
    revset?: string;
}

/**
 * Prompts for a change and returns its ID (or a typed revset) without running any jj operation.
 * Meant for `${command:jj-view.pickChange}` in tasks and launch configurations; VS Code requires a
 * string result, so `undefined` (cancelled) leaves the variable unresolved.
 */
export async function pickChangeCommand(ctx: CommandContext, payload?: PickChangePayload): Promise<string | undefined> {
    const revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
        placeHolder: 'Select a change',
        revisionQuery: payload?.revset?.trim() || RevisionQuery.visible(),
        repoRoot: ctx.repo.rootUri,
        nav: ctx.host.nav,
    });
    return revision?.trim() || undefined;
}
