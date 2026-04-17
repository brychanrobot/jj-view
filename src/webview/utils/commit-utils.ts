/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { CommitAction, JjLogEntry } from '../../jj-types';

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
    isImmutable: boolean,
    isSelected: boolean,
    selectionCount: number,
    hasImmutableSelection: boolean,
): { visibleActions: CommitActionStates; vscodeContext: Record<string, unknown> } {
    const visibleActions: CommitActionStates = {
        newChild: !hiddenActions.has('newChild'),
        edit: !isImmutable && !hiddenActions.has('edit'),
        squash: !hiddenActions.has('squash') && commit.parents_immutable?.length === 1 && !commit.parents_immutable[0],
        abandon: !isImmutable && !hiddenActions.has('abandon'),
    };

    const vscodeContext = {
        webviewSection: 'commit',
        'jj.newChildVisible': visibleActions.newChild,
        'jj.editVisible': visibleActions.edit,
        'jj.squashVisible': visibleActions.squash,
        'jj.abandonVisible': visibleActions.abandon,
        viewItem: isSelected ? 'jj-commit-selected' : 'jj-commit',
        commitId: commit.commit_id,
        changeId: commit.change_id,

        // Abandon, New Before, and New After supported on multi-selection, but also on unselected items
        'jj.canAbandon': !isImmutable && (!isSelected || !hasImmutableSelection),
        'jj.canNewBefore': !isImmutable && (!isSelected || !hasImmutableSelection),
        'jj.canNewAfter': !isSelected || !hasImmutableSelection,
        'jj.canUpload': !isImmutable && (!isSelected || !hasImmutableSelection),

        // Edit, Duplicate, and Absorb restricted to single-item context (or unselected item)
        'jj.canEdit': !isImmutable && (!isSelected || selectionCount <= 1),
        'jj.canDuplicate': !isSelected || selectionCount <= 1,
        'jj.canNewChild': !isSelected || selectionCount <= 1,

        // Rebase source must be mutable, and we rebase ONTO the current selection
        'jj.canRebaseOnto': !isImmutable && !isSelected && selectionCount > 0,

        // Merge requires multiple items selected
        'jj.canMerge': isSelected && selectionCount > 1,

        // Absorb requires at least one mutable parent and single-item context
        'jj.canAbsorb':
            commit.parents_immutable?.some((immutable: boolean) => !immutable) && (!isSelected || selectionCount <= 1),

        preventDefaultContextMenuItems: true,
    };

    return { visibleActions, vscodeContext };
}
