/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ScmContextValue } from '../jj-context-keys';
import type { JjRepository } from '../jj-repository';
import type { JjResourceState } from '../scm-resource-state';
import { getFsPathFromUri, Uri } from '../uri-utils';
import { formatCommitDescription } from '../utils/format-utils';

export { promptForRevision, showJjError, withDelayedProgress } from '../vscode/vscode-ui-helpers';

// Internal type guards to keep the messy VS Code argument matching encapsulated

function hasResourceUri(arg: unknown): arg is { resourceUri: Uri } {
    return typeof arg === 'object' && arg !== null && 'resourceUri' in arg;
}

function hasResourceStates(arg: unknown): arg is { resourceStates: unknown[] } {
    if (typeof arg !== 'object' || arg === null || !('resourceStates' in arg)) {
        return false;
    }
    const obj = arg as { resourceStates: unknown };
    return Array.isArray(obj.resourceStates);
}

export function collectResourceStates(args: unknown[]): JjResourceState[] {
    const resourceStates: JjResourceState[] = [];

    const processArg = (arg: unknown) => {
        if (!arg) {
            return;
        }

        if (Array.isArray(arg)) {
            arg.forEach(processArg);
        } else if (hasResourceUri(arg)) {
            // Context Menu: Resource State
            resourceStates.push(arg as JjResourceState);
        } else if (hasResourceStates(arg)) {
            // Context Menu: Resource Group (e.g. "Working Copy" header)
            arg.resourceStates.forEach(processArg);
        }
    };

    args.forEach(processArg);

    // De-duplicate by fsPath
    const unique = new Map<string, JjResourceState>();
    for (const state of resourceStates) {
        unique.set(getFsPathFromUri(state.resourceUri), state);
    }

    return Array.from(unique.values());
}

function extractRevisionsFromObject(arg: Record<string, unknown>, unique: Set<string>): void {
    const scalarKeys = ['revision', 'jj.revision', 'changeId', 'jj.changeId', 'commitId', 'jj.commitId'];
    for (const key of scalarKeys) {
        const val = arg[key];
        if (typeof val === 'string' && val.trim().length > 0) {
            unique.add(val.trim());
            return;
        }
    }

    const arrayKeys = ['revisions', 'jj.revisions', 'changeIds', 'jj.changeIds', 'commitIds', 'jj.commitIds'];
    for (const key of arrayKeys) {
        const val = arg[key];
        if (Array.isArray(val)) {
            for (const item of val) {
                if (typeof item === 'string' && item.trim().length > 0) {
                    unique.add(item.trim());
                }
            }
            if (unique.size > 0) {
                return;
            }
        }
    }
}

export function extractRevisions(args: unknown[]): string[] {
    const unique = new Set<string>();

    for (const arg of args) {
        if (!arg) {
            continue;
        }

        if (typeof arg === 'string' && arg.trim().length > 0) {
            unique.add(arg.trim());
            continue;
        }

        if (Array.isArray(arg)) {
            for (const rev of extractRevisions(arg)) {
                unique.add(rev);
            }
            continue;
        }

        if (isCurrentWorkingCopyResourceGroup(arg)) {
            unique.add('@');
            continue;
        }

        if (hasResourceStates(arg)) {
            for (const state of arg.resourceStates) {
                const rev = extractRevision([state]);
                if (rev) {
                    unique.add(rev);
                }
            }
            continue;
        }

        if (typeof arg === 'object' && arg !== null) {
            extractRevisionsFromObject(arg as Record<string, unknown>, unique);
        }
    }

    return Array.from(unique.values());
}

export function extractBookmarkName(args: unknown[]): string | undefined {
    const firstArg = args?.[0];

    if (typeof firstArg === 'string') {
        return firstArg.trim() || undefined;
    }

    if (firstArg && typeof firstArg === 'object') {
        const obj = firstArg as Record<string, unknown>;
        const name =
            typeof obj.name === 'string'
                ? obj.name
                : typeof obj.bookmarkName === 'string'
                  ? obj.bookmarkName
                  : undefined;
        return name?.trim() || undefined;
    }

    return undefined;
}

export interface ScmResourceGroup {
    id: string;
    label?: string;
    resourceStates?: unknown[];
}

function isSourceControlResourceGroup(arg: unknown): arg is ScmResourceGroup {
    return typeof arg === 'object' && arg !== null && 'id' in arg && 'resourceStates' in arg;
}

export function isCurrentWorkingCopyResourceGroup(arg: unknown): arg is ScmResourceGroup {
    return isSourceControlResourceGroup(arg) && arg.id === ScmContextValue.WorkingCopyGroup;
}

export function isParentResourceGroup(arg: unknown): arg is ScmResourceGroup {
    return isSourceControlResourceGroup(arg) && arg.id.startsWith('ancestor-');
}

export function extractRevision(args: unknown[]): string | undefined {
    const revisions = extractRevisions(args);
    if (revisions.length > 0) {
        return revisions[0];
    }
    return undefined;
}

/**
 * Resolves target revisions by taking explicit arguments, merging with multi-selection
 * when the clicked revision is part of the selection, or falling back to a default revision.
 */
export function resolveRevisionsWithSelection(
    args: unknown[],
    scmProvider?: { getSelectedCommitIds?: () => string[] },
    fallback = '@',
): string[] {
    const argRevisions = extractRevisions(args);
    const selectedIds = scmProvider?.getSelectedCommitIds?.() ?? [];

    if (argRevisions.length > 0) {
        const target = argRevisions[0];
        return selectedIds.includes(target) ? selectedIds : argRevisions;
    }
    if (selectedIds.length > 0) {
        return selectedIds;
    }
    return [fallback];
}

const COMMON_TARGET_REVISION_KEYS = ['intoRevision', 'targetRevision', 'target', 'destination', 'to'];

function extractTargetRevisionByKeys(
    args: unknown[],
    specificKeys: string[],
    sourceRevision?: string,
): string | undefined {
    const keys = [...specificKeys, ...COMMON_TARGET_REVISION_KEYS];
    for (const arg of args) {
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
            const obj = arg as Record<string, unknown>;
            for (const key of keys) {
                const val = obj[key];
                if (typeof val === 'string' && val.trim().length > 0) {
                    return val.trim();
                }
            }
        }
    }

    const revisions = extractRevisions(args);
    if (sourceRevision) {
        const candidate = revisions.find((r) => r !== sourceRevision);
        if (candidate) {
            return candidate;
        }
    } else if (revisions.length > 1) {
        return revisions[1];
    }

    return undefined;
}

export function extractAncestorRevision(args: unknown[], sourceRevision?: string): string | undefined {
    return extractTargetRevisionByKeys(args, ['ancestorRevision', 'ancestor'], sourceRevision);
}

export function extractChildRevision(args: unknown[], sourceRevision?: string): string | undefined {
    return extractTargetRevisionByKeys(args, ['childRevision', 'child'], sourceRevision);
}

export function extractTargetParent(args: unknown[], sourceRevision?: string): string | undefined {
    return extractTargetRevisionByKeys(args, ['targetParent', 'parent'], sourceRevision);
}

export function extractUriFromArgs(args: unknown[]): Uri | undefined {
    for (const arg of args) {
        if (Uri.isUri(arg)) {
            return arg;
        }
        if (typeof arg === 'string') {
            try {
                return Uri.parse(arg);
            } catch (_) {
                // Ignore parse failures for plain strings that aren't valid URIs
            }
        }
        if (hasResourceUri(arg)) {
            return arg.resourceUri;
        }
    }
    return undefined;
}
export function extractFileUri(args: unknown[]): Uri | undefined {
    const uri = extractUriFromArgs(args);
    if (uri) {
        return uri;
    }
    const firstArg = args[0];
    if (firstArg && typeof firstArg === 'object' && firstArg !== null && 'resourceUri' in firstArg) {
        const state = firstArg as { resourceUri: unknown };
        if (Uri.isUri(state.resourceUri)) {
            return state.resourceUri;
        }
    }
    return undefined;
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export const RevisionQuery = {
    Parents: 'parents(@)',
    Ancestors: 'ancestors(@)',
    All: 'all()',
    ancestorsExcluding: (rev: string) => `ancestors(${rev}) ~ ${rev}`,
    ancestorsIncluding: (rev: string) => `ancestors(${rev})`,
    mutable: () => 'mutable()',
    visible: () => 'visible()',
    children: (rev: string) => `children(${rev})`,
} as const;

export interface DescriptionFormatContext {
    repo: JjRepository;
    config: {
        get<T>(key: string): T | undefined;
    };
    ui?: {
        setCommitInput?(value: string): void;
        getCommitInput?(): string | undefined;
    };
    services?: {
        commentsManager?: {
            formatUnresolvedCommentsSummary?: () => Promise<string | undefined>;
        };
    };
}

export async function prepareCommitDescription(
    ctx: DescriptionFormatContext,
    options: {
        currentDescription?: string;
        insertCommentsSummary?: boolean;
    } = {},
): Promise<string> {
    let description = options.currentDescription ?? '';
    const shouldInsertSummary =
        options.insertCommentsSummary ?? ctx.config.get<boolean>('autoInsertUnresolvedCommentsSummary') ?? true;

    if (shouldInsertSummary && ctx.services?.commentsManager?.formatUnresolvedCommentsSummary) {
        const commentsSummary = await ctx.services.commentsManager.formatUnresolvedCommentsSummary();
        if (commentsSummary) {
            description = `${description.trimEnd()}\n\n${commentsSummary}`;
        }
    }

    return description;
}

export async function maybeFormatDescriptionOnSave(
    description: string,
    ctx: DescriptionFormatContext,
    revision: string = '@',
): Promise<string> {
    description = await prepareCommitDescription(ctx, { currentDescription: description });

    const formatOnSave = ctx.config.get<boolean>('commit.formatDescriptionOnSave') ?? false;
    if (!formatOnSave) {
        return description;
    }

    const bodyWidthRuler = ctx.config.get<number>('commit.bodyWidthRuler') ?? 72;
    description = await formatCommitDescription(description, bodyWidthRuler);

    if (revision === '@' && ctx.ui?.setCommitInput) {
        ctx.ui.setCommitInput(description);
    }
    return description;
}
