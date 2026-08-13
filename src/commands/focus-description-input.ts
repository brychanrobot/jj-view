/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../common/command-context';

export async function focusDescriptionInputCommand(ctx: CommandContext): Promise<void> {
    await ctx.nav.focusScmInput?.();
}
