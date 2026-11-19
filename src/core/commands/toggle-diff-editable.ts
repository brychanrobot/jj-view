/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import type { HostDiffTab } from '../host/host-environment';
import { showJjError } from '../host/ui-helpers';
import { normalizeRepoSeparators } from '../path-utils';
import {
    createRepoFileUri,
    createRevisionUri,
    decodeJjViewQuery,
    encodeJjViewQuery,
    getRepoRelativePath,
    getRevisionFromUri,
    getUriParams,
    type Uri,
} from '../uri-utils';

export interface ToggleDiffEditablePayload {
    leftUri?: Uri;
    rightUri?: Uri;
    resourceUri?: Uri;
    title?: string;
}

interface ResolvedToggleTarget {
    targetUri: Uri;
    leftUri?: Uri;
    title?: string;
    matchingDiffTab?: HostDiffTab;
    isLeftPaneOnly: boolean;
}

function resolveToggleTarget(
    ctx: CommandContext,
    payload?: ToggleDiffEditablePayload,
): ResolvedToggleTarget | undefined {
    const rawTargetUri = payload?.rightUri ?? payload?.resourceUri ?? ctx.host.documents.getActiveDocumentUri?.();
    if (!rawTargetUri) {
        return undefined;
    }

    const openDiffTabs = ctx.host.documents.getOpenDiffTabs?.() ?? [];
    if (payload?.leftUri && payload.rightUri) {
        const leftStr = payload.leftUri.toString();
        const rightStr = payload.rightUri.toString();
        const matchingDiffTab = openDiffTabs.find(
            (tab) => tab.originalUri.toString() === leftStr && tab.modifiedUri.toString() === rightStr,
        );
        return {
            targetUri: payload.rightUri,
            leftUri: payload.leftUri,
            title: payload.title ?? matchingDiffTab?.label,
            matchingDiffTab,
            isLeftPaneOnly: false,
        };
    }

    const targetStr = rawTargetUri.toString();
    const matchingDiffTab = openDiffTabs.find((tab) => tab.modifiedUri.toString() === targetStr);
    if (matchingDiffTab) {
        return {
            targetUri: matchingDiffTab.modifiedUri,
            leftUri: matchingDiffTab.originalUri,
            title: payload?.title ?? matchingDiffTab.label,
            matchingDiffTab,
            isLeftPaneOnly: false,
        };
    }

    const isLeftPaneOnly = openDiffTabs.some(
        (tab) => tab.originalUri.toString() === targetStr && tab.modifiedUri.toString() !== targetStr,
    );
    return {
        targetUri: rawTargetUri,
        title: payload?.title,
        isLeftPaneOnly,
    };
}

async function closeReplacedTab(ctx: CommandContext, target: ResolvedToggleTarget): Promise<void> {
    if (target.matchingDiffTab) {
        await target.matchingDiffTab.close();
        return;
    }
    await ctx.host.nav.closeTab(target.targetUri);
}

/**
 * Switches a read-only revision file or diff view (`jj-view://`) to editable mode (`jj-edit://`).
 */
export async function enableDiffEditingCommand(
    ctx: CommandContext,
    payload?: ToggleDiffEditablePayload,
): Promise<void> {
    try {
        const target = resolveToggleTarget(ctx, payload);
        if (!target) {
            return;
        }

        const { targetUri, leftUri, title, isLeftPaneOnly } = target;
        if (targetUri.scheme !== 'jj-view') {
            return;
        }

        if (isLeftPaneOnly) {
            void ctx.host.ui.showInformation('Cannot edit the original (left) side of a diff.');
            return;
        }

        const query = decodeJjViewQuery(targetUri);
        if (query.mode === 'diff' && query.side === 'left') {
            void ctx.host.ui.showInformation('Cannot edit the parent (left) side of a diff.');
            return;
        }
        if (query.mode === 'uploaded' || query.mode === 'text') {
            void ctx.host.ui.showInformation('Cannot edit a read-only preview document.');
            return;
        }

        const revision = getRevisionFromUri(targetUri);
        if (!revision || revision === 'none' || /^0{7,64}$/.test(revision)) {
            void ctx.host.ui.showInformation('Cannot edit file: no editable revision associated with this view.');
            return;
        }

        const entries = await ctx.repo.jj.getLog({ revision, limit: 2, omitChanges: true });
        if (entries.length > 1) {
            void ctx.host.ui.showWarning(`Cannot edit file: revision "${revision}" matches multiple commits.`);
            return;
        }
        const entry = entries[0];
        if (!entry || entry.is_immutable) {
            void ctx.host.ui.showWarning('Cannot edit file: revision is immutable.');
            return;
        }

        const params = getUriParams(targetUri);
        const root = params.get('root') || params.get('repoRoot') || ctx.repo.jj.workspaceRoot;
        const platform = ctx.repo.jj.system.platform;
        const relPath = getRepoRelativePath(targetUri, root, platform);
        const cleanPath = relPath.startsWith('/') ? relPath.slice(1) : relPath;
        const targetRevision = revision.includes('/') ? revision : entry.change_id || revision;

        const changes = await ctx.repo.jj.getChanges(targetRevision);
        const isDeletedInRevision = changes.some(
            (change) => change.status === 'deleted' && normalizeRepoSeparators(change.path, platform) === cleanPath,
        );
        if (isDeletedInRevision) {
            void ctx.host.ui.showInformation('Cannot edit a deleted file.');
            return;
        }

        const resourceParams = new URLSearchParams();
        resourceParams.set('root', root);
        resourceParams.set('jj-revision', targetRevision);
        resourceParams.set('revision', entry.is_current_working_copy ? '@' : targetRevision);

        const editUri = createRepoFileUri(root, cleanPath, 'jj-edit', {
            fragment: resourceParams.toString(),
            platform,
        });

        if (leftUri) {
            const diffTitle = title || `${cleanPath} (${targetRevision})`;
            await ctx.host.nav.openDiff(leftUri, editUri, diffTitle, { preview: false });
        } else {
            await ctx.host.nav.openFile(editUri, { preview: false });
        }

        await closeReplacedTab(ctx, target);
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to enable diff editing', ctx.repo.jj, ctx.log);
    }
}

/**
 * Flushes unsaved edits and switches an editable revision file or diff view (`jj-edit://`) back to read-only (`jj-view://`).
 */
export async function disableDiffEditingCommand(
    ctx: CommandContext,
    payload?: ToggleDiffEditablePayload,
): Promise<void> {
    try {
        const target = resolveToggleTarget(ctx, payload);
        if (!target) {
            return;
        }

        const { targetUri, leftUri, title } = target;
        if (targetUri.scheme !== 'jj-edit') {
            return;
        }

        const revision = getRevisionFromUri(targetUri);
        if (!revision || revision === 'none' || /^0{7,64}$/.test(revision)) {
            void ctx.host.ui.showInformation(
                'Cannot switch file to read-only: no revision is associated with this view.',
            );
            return;
        }

        const params = getUriParams(targetUri);
        const root = params.get('root') || params.get('repoRoot') || ctx.repo.jj.workspaceRoot;
        const platform = ctx.repo.jj.system.platform;
        const relPath = getRepoRelativePath(targetUri, root, platform);
        const cleanPath = relPath.startsWith('/') ? relPath.slice(1) : relPath;

        await ctx.host.documents.saveIfDirty(targetUri);

        if (leftUri) {
            const viewUri = createRepoFileUri(root, cleanPath, 'jj-view', {
                fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'right' }),
                platform,
            });
            const diffTitle = title || `${cleanPath} (${revision})`;
            await ctx.host.nav.openDiff(leftUri, viewUri, diffTitle, { preview: false });
        } else {
            const viewUri = createRevisionUri(root, cleanPath, revision, platform);
            await ctx.host.nav.openFile(viewUri, { preview: false });
        }

        await closeReplacedTab(ctx, target);
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to switch diff to read-only', ctx.repo.jj, ctx.log);
    }
}
