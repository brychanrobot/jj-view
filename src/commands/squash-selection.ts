/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { CommandContext } from '../common/command-context';
import { getFsPathFromUri, getRevisionFromUri, type Uri } from '../uri-utils';

export interface SquashHunkIntoParentPayload {
    uri?: Uri;
    ranges?: { startLine: number; endLine: number }[];
    revision?: string;
}

export interface SquashSelectionIntoParentPayload {
    uri?: Uri;
    ranges?: { startLine: number; endLine: number }[];
    revision?: string;
}

export async function squashHunkIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashHunkIntoParentPayload,
): Promise<void> {
    const uri = payload?.uri;
    const ranges = payload?.ranges;
    if (!uri || !ranges || ranges.length === 0) {
        return;
    }

    const relPath = path.relative(ctx.repo.jj.workspaceRoot, getFsPathFromUri(uri));
    const revision = payload?.revision || getRevisionFromUri(uri) || '@';

    try {
        await ctx.repo.jj.squashSelectionIntoParent(relPath, ranges, revision);
        await ctx.repo.refresh({ reason: 'after squash hunk into parent' });
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Failed to squash hunk');
    }
}

export async function squashSelectionIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashSelectionIntoParentPayload,
): Promise<void> {
    const uri = payload?.uri;
    const ranges = payload?.ranges;
    if (!uri || !ranges || ranges.length === 0) {
        return;
    }

    const fsPath = getFsPathFromUri(uri);
    const relPath = path.relative(ctx.repo.jj.workspaceRoot, fsPath);
    const revision = payload?.revision || getRevisionFromUri(uri) || '@';

    try {
        await ctx.repo.jj.squashSelectionIntoParent(relPath, ranges, revision);
    } catch (e: unknown) {
        await ctx.ui.showError(e, 'Failed to squash selection');
    } finally {
        await ctx.repo.refresh({ reason: 'after squash selection into parent' });
    }
}
