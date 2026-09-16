/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { canAbsorbCommit, canSquashCommit, isMutableCommit } from '../../../../utils/jj-utils';
import type { CommitAction } from '../../../host/ipc/log-view-schemas';
import type { JjLogEntry } from '../../../jj-types';

export interface CommitActionStates {
    newChild: boolean;
    edit: boolean;
    squash: boolean;
    abandon: boolean;
}

/**
 * Computes the visibility and context key states for a commit node.
 * Extracted from CommitNode.tsx to allow unit testing of the visibility logic.
 */
export function computeCommitActions(
    commit: JjLogEntry,
    hiddenActions: Set<CommitAction>,
    isSelected: boolean,
    selectionCount: number,
    hasImmutableSelection: boolean,
): { visibleActions: CommitActionStates; vscodeContext: Record<string, unknown> } {
    const visibleActions: CommitActionStates = {
        newChild: !hiddenActions.has('newChild'),
        edit: isMutableCommit(commit) && !commit.is_current_working_copy && !hiddenActions.has('edit'),
        squash: !hiddenActions.has('squash') && canSquashCommit(commit),
        abandon: isMutableCommit(commit) && !hiddenActions.has('abandon'),
    };

    const vscodeContext = {
        webviewSection: 'commit',
        'jj.isCurrentWorkingCopy': commit.is_current_working_copy,

        'jj.newChildVisible': visibleActions.newChild,
        'jj.editVisible': visibleActions.edit,
        'jj.squashVisible': visibleActions.squash,
        'jj.abandonVisible': visibleActions.abandon,
        viewItem: isSelected ? 'jj-commit-selected' : 'jj-commit',
        commitId: commit.commit_id,
        changeId: commit.change_id,

        // Abandon, New Before, and New After supported on multi-selection, but also on unselected items
        'jj.canAbandon': isMutableCommit(commit) && (!isSelected || !hasImmutableSelection),
        'jj.canNewBefore': isMutableCommit(commit) && (!isSelected || !hasImmutableSelection),
        'jj.canNewAfter': !isSelected || !hasImmutableSelection,
        'jj.canUpload': isMutableCommit(commit) && (!isSelected || !hasImmutableSelection),

        // Edit, Duplicate, and Absorb restricted to single-item context (or unselected item)
        'jj.canEdit':
            isMutableCommit(commit) && !commit.is_current_working_copy && (!isSelected || selectionCount <= 1),
        'jj.canDuplicate': !isSelected || selectionCount <= 1,
        'jj.canNewChild': !isSelected || selectionCount <= 1,

        // Rebase source must be mutable, and we rebase ONTO the current selection
        'jj.canRebaseOnto': isMutableCommit(commit) && !isSelected && selectionCount > 0,

        // Merge requires multiple items selected
        'jj.canMerge': isSelected && selectionCount > 1,

        // Absorb requires at least one mutable parent and single-item context
        'jj.canAbsorb': canAbsorbCommit(commit) && (!isSelected || selectionCount <= 1),

        preventDefaultContextMenuItems: true,
    };

    return { visibleActions, vscodeContext };
}

/**
 * Searches a list of log entries for a commit matching the given query string.
 * Supports exact or prefix matches on change IDs (with or without divergent offset),
 * commit IDs (SHAs), bookmark names, tags, and working copy references ('@' and '@-').
 */
export function findMatchingCommit(commits: readonly JjLogEntry[], query: string | undefined): JjLogEntry | undefined {
    if (!query) {
        return undefined;
    }
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
        return undefined;
    }

    // 1. Exact match on change_id (or base change_id without /offset)
    const exactChange = commits.find((c) => {
        const baseId = c.change_id.toLowerCase().split('/')[0];
        return c.change_id.toLowerCase() === q || baseId === q;
    });
    if (exactChange) {
        return exactChange;
    }

    // 2. Exact match on commit_id (SHA)
    const exactCommit = commits.find((c) => c.commit_id.toLowerCase() === q);
    if (exactCommit) {
        return exactCommit;
    }

    // 3. Exact match on bookmark name or remote bookmark
    const exactBookmark = commits.find((c) =>
        c.bookmarks?.some(
            (b) => b.name.toLowerCase() === q || (b.remote && `${b.name}@${b.remote}`.toLowerCase() === q),
        ),
    );
    if (exactBookmark) {
        return exactBookmark;
    }

    // 4. Exact match on tag
    const exactTag = commits.find((c) => c.tags?.some((t) => t.toLowerCase() === q));
    if (exactTag) {
        return exactTag;
    }

    // 5. Working copy @
    if (q === '@') {
        const wc = commits.find((c) => c.is_current_working_copy);
        if (wc) {
            return wc;
        }
    }

    // 6. Working copy parent @-
    if (q === '@-') {
        const wc = commits.find((c) => c.is_current_working_copy);
        if (wc?.parents && wc.parents.length > 0) {
            const parentCommitId = wc.parents[0].commit_id;
            const parent = commits.find((c) => c.commit_id === parentCommitId);
            if (parent) {
                return parent;
            }
        }
    }

    // 7. Prefix match on change_id (e.g. typing "kkm" or "qut")
    const prefixChange = commits.find((c) => {
        const baseId = c.change_id.toLowerCase().split('/')[0];
        return c.change_id.toLowerCase().startsWith(q) || baseId.startsWith(q);
    });
    if (prefixChange) {
        return prefixChange;
    }

    // 8. Prefix match on commit_id (SHA)
    const prefixCommit = commits.find((c) => c.commit_id.toLowerCase().startsWith(q));
    if (prefixCommit) {
        return prefixCommit;
    }

    // 9. Prefix match on bookmark name or remote bookmark
    const prefixBookmark = commits.find((c) =>
        c.bookmarks?.some(
            (b) =>
                b.name.toLowerCase().startsWith(q) || (b.remote && `${b.name}@${b.remote}`.toLowerCase().startsWith(q)),
        ),
    );
    if (prefixBookmark) {
        return prefixBookmark;
    }

    // 10. Prefix match on tag
    const prefixTag = commits.find((c) => c.tags?.some((t) => t.toLowerCase().startsWith(q)));
    if (prefixTag) {
        return prefixTag;
    }

    return undefined;
}
