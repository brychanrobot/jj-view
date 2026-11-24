/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import type { JjWorkspace } from '../jj-types';

export interface ResolvedWorkspace {
    name: string;
    path?: string;
    changeId?: string;
    shortestChangeId?: string;
}

/**
 * Formats a user-facing workspace label including the workspace name and, when known,
 * the shortest unique change ID prefix (never the full change ID).
 */
export function formatWorkspaceLabel(workspace: { name: string; shortestChangeId?: string }): string {
    const shortId = workspace.shortestChangeId?.trim();
    if (shortId) {
        return `workspace "${workspace.name}" (change ${shortId})`;
    }
    return `workspace "${workspace.name}"`;
}

function toResolvedWorkspace(w: JjWorkspace): ResolvedWorkspace {
    return {
        name: w.name,
        path: w.path || undefined,
        changeId: w.change_id,
        shortestChangeId: w.change_id_shortest,
    };
}

/**
 * Resolves a workspace (name, optional path, and change ID metadata) from a provided name
 * or by prompting the user with a QuickPick.
 *
 * @param ctx The command context.
 * @param providedWorkspaceName Optional workspace name provided directly via payload.
 * @returns The resolved workspace details, or undefined if the user cancelled or no workspaces were found.
 */
export async function resolveWorkspace(
    ctx: CommandContext,
    providedWorkspaceName?: string,
): Promise<ResolvedWorkspace | undefined> {
    const { jj } = ctx.repo;
    const { ui } = ctx.host;

    const trimmed = providedWorkspaceName?.trim();
    if (trimmed) {
        const workspaces = await jj.getWorkspaces().catch(() => []);
        const matched = workspaces.find((w) => w.name === trimmed);
        return matched ? toResolvedWorkspace(matched) : { name: trimmed };
    }

    const workspaces: JjWorkspace[] = await jj.getWorkspaces();

    if (workspaces.length === 0) {
        await showJjError(ui, new Error('No workspaces found in this repository.'), 'Workspace Error', jj, ctx.log);
        return undefined;
    }

    if (workspaces.length === 1) {
        return toResolvedWorkspace(workspaces[0]);
    }

    const items = workspaces.map((w) => {
        const shortId = w.change_id_shortest?.trim();
        const description = shortId ? (w.path ? `${shortId} · ${w.path}` : shortId) : w.path;
        return {
            label: w.name,
            description,
        };
    });

    const selection = await ui.showQuickPick(items, {
        placeHolder: 'Select a workspace to operate on',
    });

    if (!selection) {
        return undefined;
    }

    const matched = workspaces.find((w) => w.name === selection.label);
    return matched ? toResolvedWorkspace(matched) : { name: selection.label };
}

/**
 * Resolves a workspace name from a provided name or by prompting the user with a QuickPick.
 *
 * @param ctx The command context.
 * @param providedWorkspaceName Optional workspace name provided directly via payload.
 * @returns The resolved workspace name, or undefined if the user cancelled or no workspaces were found.
 */
export async function resolveWorkspaceName(
    ctx: CommandContext,
    providedWorkspaceName?: string,
): Promise<string | undefined> {
    const trimmed = providedWorkspaceName?.trim();
    if (trimmed) {
        return trimmed;
    }
    const resolved = await resolveWorkspace(ctx);
    return resolved?.name;
}
