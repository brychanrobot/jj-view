/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatCommitDescription } from '../../utils/format-utils';
import { extractRemoteLineRange } from '../../utils/remote-url-utils';
import type { HostFs, HostPlatform } from '../host/host-system';
import { ScmContextValue } from '../jj-context-keys';
import { isWindowsStylePath, pathNormalize, pathRelative } from '../path-utils';
import type { JjResourceState } from '../scm-resource-state';
import {
    getFsPathFromUri,
    getRevisionFromUri,
    isInsideRelativePath,
    isWorkingCopyRevision,
    normalizeDriveLetter,
    resolveInsideRealRootAsync,
    Uri,
} from '../uri-utils';
import type { RemoteFileUrlPayload } from './remote-file-url';

// Internal type guards to keep the messy VS Code argument matching encapsulated

function hasResourceUri(arg: unknown): arg is { resourceUri: Uri } {
    return (
        typeof arg === 'object' &&
        arg !== null &&
        'resourceUri' in arg &&
        Uri.isUri((arg as { resourceUri: unknown }).resourceUri)
    );
}

export interface LineChange {
    readonly originalStartLineNumber: number;
    readonly originalEndLineNumber: number;
    readonly modifiedStartLineNumber: number;
    readonly modifiedEndLineNumber: number;
}

export function isLineChangeArray(changes: unknown): changes is LineChange[] {
    if (!Array.isArray(changes)) {
        return false;
    }
    return changes.every((c) => {
        const change = c as LineChange;
        return (
            typeof change.originalStartLineNumber === 'number' &&
            typeof change.originalEndLineNumber === 'number' &&
            typeof change.modifiedStartLineNumber === 'number' &&
            typeof change.modifiedEndLineNumber === 'number'
        );
    });
}

function hasResourceStates(arg: unknown): arg is { resourceStates: unknown[] } {
    if (typeof arg !== 'object' || arg === null || !('resourceStates' in arg)) {
        return false;
    }
    const obj = arg as { resourceStates: unknown };
    return Array.isArray(obj.resourceStates);
}

function collectResourceStatesRaw(args: unknown[]): JjResourceState[] {
    const resourceStates: JjResourceState[] = [];

    const processArg = (arg: unknown): void => {
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
    return resourceStates;
}

export function collectResourceStates(args: unknown[], platform?: HostPlatform | string): JjResourceState[] {
    // De-duplicate by fsPath
    const unique = new Map<string, JjResourceState>();
    for (const state of collectResourceStatesRaw(args)) {
        unique.set(getFsPathFromUri(state.resourceUri, platform), state);
    }

    return Array.from(unique.values());
}

function extractRevisionsFromObject(arg: Record<string, unknown>, unique: Set<string>): void {
    const scalarKeys = [
        'revision',
        'jj.revision',
        'changeId',
        'jj.changeId',
        'change_id',
        'commitId',
        'jj.commitId',
        'commit_id',
        'bookmarkName',
        'bookmark',
    ];
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

    if (typeof arg.ancestor === 'object' && arg.ancestor !== null) {
        extractRevisionsFromObject(arg.ancestor as Record<string, unknown>, unique);
        if (unique.size > 0) {
            return;
        }
    }

    if (typeof arg.entry === 'object' && arg.entry !== null) {
        extractRevisionsFromObject(arg.entry as Record<string, unknown>, unique);
        if (unique.size > 0) {
            return;
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

/**
 * Resolves a filesystem path to a workspace-relative path, verifying containment
 * across symlinks via `fs.realpath`. Returns `undefined` when outside the workspace.
 */
export async function resolveWorkspaceRelativePath(
    workspaceRoot: string,
    filePath: string,
    fs?: HostFs,
    platform?: HostPlatform | string,
): Promise<string | undefined> {
    const effectivePlatform =
        platform ?? (isWindowsStylePath(workspaceRoot) || isWindowsStylePath(filePath) ? 'win32' : undefined);
    const relFromRoot = pathRelative(
        normalizeDriveLetter(workspaceRoot),
        normalizeDriveLetter(filePath),
        effectivePlatform,
    );
    if (isInsideRelativePath(relFromRoot, effectivePlatform)) {
        return pathNormalize(relFromRoot, effectivePlatform);
    }
    if (!fs) {
        return undefined;
    }
    let realRoot = workspaceRoot;
    try {
        realRoot = await fs.realpath(workspaceRoot);
    } catch {
        // Keep original workspaceRoot when realpath is unavailable
    }
    return resolveInsideRealRootAsync(filePath, realRoot, fs, effectivePlatform);
}

/**
 * Extracts file paths and target revision from either SCM resource states
 * or explicit `{ paths, revision }` command payload objects.
 */
export function extractSplitFilesPayload(
    args: unknown[],
    platform?: HostPlatform | string,
): {
    paths: string[];
    revision: string;
    validationError?: string;
} {
    const rawStates = collectResourceStatesRaw(args);
    if (rawStates.length > 0) {
        const distinctRevisions = new Set<string>();
        for (const state of rawStates) {
            const stateRevision = state.revision?.trim() || getRevisionFromUri(state.resourceUri)?.trim();
            if (stateRevision) {
                distinctRevisions.add(stateRevision);
            }
        }
        if (distinctRevisions.size > 1) {
            return {
                paths: [],
                revision: Array.from(distinctRevisions)[0],
                validationError:
                    'Cannot split files selected across multiple revisions. Select files from a single change.',
            };
        }

        const uniquePaths = new Set<string>();
        const paths: string[] = [];
        for (const state of rawStates) {
            const fsPath = getFsPathFromUri(state.resourceUri, platform);
            if (!uniquePaths.has(fsPath)) {
                uniquePaths.add(fsPath);
                paths.push(fsPath);
            }
        }
        const revision = Array.from(distinctRevisions)[0] || extractRevision(args) || '@';
        return { paths, revision };
    }

    const paths: string[] = [];
    const seen = new Set<string>();
    for (const arg of args) {
        if (!arg || typeof arg !== 'object' || Array.isArray(arg) || !('paths' in arg)) {
            continue;
        }
        if (!Array.isArray(arg.paths)) {
            continue;
        }
        for (const item of arg.paths) {
            if (typeof item === 'string' && item.trim().length > 0 && !seen.has(item)) {
                seen.add(item);
                paths.push(item);
            }
        }
    }

    const revision = extractRevision(args) || '@';
    return { paths, revision };
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

/**
 * Extracts a workspace name from a string argument or context/payload object,
 * checking `workspaceName` before `name` and never falling back to revision IDs.
 */
export function extractWorkspaceName(args: unknown[]): string | undefined {
    const firstArg = args?.[0];

    if (typeof firstArg === 'string') {
        return firstArg.trim() || undefined;
    }

    if (firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)) {
        if ('workspaceName' in firstArg && typeof firstArg.workspaceName === 'string') {
            return firstArg.workspaceName.trim() || undefined;
        }
        if ('name' in firstArg && typeof firstArg.name === 'string') {
            return firstArg.name.trim() || undefined;
        }
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

export interface AncestorSnapshotEntry {
    readonly entry: { readonly change_id: string };
}

/**
 * Resolves the target revision from command arguments, falling back to snapshot ancestor
 * lookup when invoked on an empty `ancestor-<index>` SCM resource group.
 */
export function resolveRevisionFromArgsOrScm(args: unknown[], ancestors?: readonly AncestorSnapshotEntry[]): string {
    const extracted = extractRevision(args);
    if (extracted) {
        return extracted;
    }

    const parentGroup = args.find(isParentResourceGroup);
    if (parentGroup) {
        const rawIndex = parentGroup.id.slice('ancestor-'.length);
        const index = /^\d+$/.test(rawIndex) ? Number.parseInt(rawIndex, 10) : -1;
        const ancestor = index >= 0 ? ancestors?.[index] : undefined;
        if (!ancestor) {
            throw new Error(`Could not resolve revision for resource group ${parentGroup.id}`);
        }
        return ancestor.entry.change_id;
    }

    return '@';
}

/**
 * Extracts target revisions from command arguments and current graph selection,
 * returning ['@'] for the working-copy SCM group or [] when neither is present.
 */
export function extractSelectedOrArgRevisions(args: unknown[], selectedRevisions: readonly string[] = []): string[] {
    if (args.some((arg) => isCurrentWorkingCopyResourceGroup(arg))) {
        return ['@'];
    }

    const argRevisions = extractRevisions(args);
    if (argRevisions.length > 1) {
        return argRevisions;
    }
    if (argRevisions.length === 1) {
        const clicked = argRevisions[0];
        return selectedRevisions.includes(clicked) ? [...selectedRevisions] : [clicked];
    }
    if (selectedRevisions.length > 0) {
        return [...selectedRevisions];
    }
    return [];
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
    return extractUriFromArgs(args);
}

/**
 * Converts a `Uri` instance or serialized URI-like object into a canonical core `Uri`.
 */
export function reviveUriLike(value: unknown): Uri | undefined {
    if (Uri.isUri(value)) {
        return value;
    }
    if (typeof value !== 'object' || value === null || !('scheme' in value) || !('path' in value)) {
        return undefined;
    }
    if (typeof value.scheme !== 'string' || typeof value.path !== 'string') {
        return undefined;
    }
    return Uri.from({
        scheme: value.scheme,
        authority: 'authority' in value && typeof value.authority === 'string' ? value.authority : '',
        path: value.path,
        query: 'query' in value && typeof value.query === 'string' ? value.query : '',
        fragment: 'fragment' in value && typeof value.fragment === 'string' ? value.fragment : '',
    });
}

export interface ExtractedRemoteFileUrlArgs {
    payload: RemoteFileUrlPayload;
    hasExplicitSource: boolean;
}

/**
 * Extracts a normalized `RemoteFileUrlPayload` from explicit payload objects, SCM resource states,
 * or URI command arguments using strict type narrowing across VS Code and Web hosts.
 */
export function extractRemoteFileUrlPayload(args: unknown[]): ExtractedRemoteFileUrlArgs {
    const firstArg = args[0];

    if (typeof firstArg === 'object' && firstArg !== null && !Array.isArray(firstArg) && !reviveUriLike(firstArg)) {
        const hasExplicitKeys =
            'filePath' in firstArg || 'fileUri' in firstArg || 'lineRange' in firstArg || 'menuId' in firstArg;
        if (hasExplicitKeys) {
            const explicitUri =
                ('fileUri' in firstArg ? reviveUriLike(firstArg.fileUri) : undefined) ??
                ('resourceUri' in firstArg ? reviveUriLike(firstArg.resourceUri) : undefined);
            const rawFilePath =
                'filePath' in firstArg && typeof firstArg.filePath === 'string' ? firstArg.filePath : undefined;
            const rawRevision =
                'revision' in firstArg && typeof firstArg.revision === 'string'
                    ? firstArg.revision
                    : extractRevision(args);
            const revision =
                explicitUri?.scheme === 'file' || (rawRevision && isWorkingCopyRevision(rawRevision))
                    ? undefined
                    : rawRevision;
            const skipActiveSelection =
                'skipActiveSelection' in firstArg && typeof firstArg.skipActiveSelection === 'boolean'
                    ? firstArg.skipActiveSelection
                    : Boolean(rawFilePath && !explicitUri);

            return {
                hasExplicitSource: true,
                payload: {
                    fileUri: explicitUri,
                    filePath: rawFilePath,
                    isRepoRelative:
                        'isRepoRelative' in firstArg && typeof firstArg.isRepoRelative === 'boolean'
                            ? firstArg.isRepoRelative
                            : undefined,
                    revision,
                    fileStatus:
                        'fileStatus' in firstArg && typeof firstArg.fileStatus === 'string'
                            ? firstArg.fileStatus
                            : undefined,
                    lineRange: 'lineRange' in firstArg ? extractRemoteLineRange(firstArg.lineRange) : undefined,
                    skipActiveSelection,
                },
            };
        }

        if ('resourceUri' in firstArg) {
            const resourceUri = reviveUriLike(firstArg.resourceUri);
            if (resourceUri) {
                const rawRevision =
                    'revision' in firstArg && typeof firstArg.revision === 'string'
                        ? firstArg.revision
                        : extractRevision(args);
                const revision =
                    resourceUri.scheme === 'file' || (rawRevision && isWorkingCopyRevision(rawRevision))
                        ? undefined
                        : rawRevision;
                return {
                    hasExplicitSource: true,
                    payload: {
                        fileUri: resourceUri,
                        revision,
                        fileStatus:
                            'status' in firstArg && typeof firstArg.status === 'string' ? firstArg.status : undefined,
                        skipActiveSelection: true,
                    },
                };
            }
        }
    }

    const argUri = extractFileUri(args);
    if (argUri) {
        const coreUri = reviveUriLike(argUri) ?? argUri;
        return {
            hasExplicitSource: true,
            payload: {
                fileUri: coreUri,
                revision: coreUri.scheme === 'file' ? undefined : extractRevision(args),
            },
        };
    }

    return { hasExplicitSource: false, payload: {} };
}

export { getErrorMessage, toError } from '../../utils/error-utils';

export const RevisionQuery = {
    Parents: 'parents(@)',
    Ancestors: 'ancestors(@)',
    All: 'all()',
    ancestorsExcluding: (rev: string) => `ancestors(${rev}) ~ ${rev}`,
    ancestorsIncluding: (rev: string) => `ancestors(${rev})`,
    mutableAncestorsExcluding: (rev: string) => `(ancestors(${rev}) ~ ${rev}) & mutable()`,
    mutableAncestorsIncluding: (rev: string) => `ancestors(${rev}) & mutable()`,
    mutable: () => 'mutable()',
    visible: () => 'visible()',
    visibleNonRoot: () => 'visible() ~ root()',
    children: (rev: string) => `children(${rev})`,
} as const;

export interface DescriptionFormatContext {
    host: {
        config: {
            get<T>(key: string): T | undefined;
        };
    };
}

export async function maybeFormatDescriptionOnSave(
    description: string,
    ctx: DescriptionFormatContext,
): Promise<string> {
    const formatOnSave = ctx.host.config.get<boolean>('commit.formatDescriptionOnSave') ?? false;
    if (!formatOnSave) {
        return description;
    }

    const bodyWidthRuler = ctx.host.config.get<number>('commit.bodyWidthRuler') ?? 72;
    return await formatCommitDescription(description, bodyWidthRuler);
}
