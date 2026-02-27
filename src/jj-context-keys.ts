/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context keys used in package.json "when" clauses.
 * These control visibility of menu items and buttons.
 */
export enum JjContextKey {
    /** True when the working copy's parent is mutable (not immutable/root) */
    ParentMutable = 'jj.parentMutable',

    /** True when the working copy has at least one child commit */
    HasChild = 'jj.hasChild',

    /** True when log selection allows abandon (items selected, none immutable) */
    SelectionAllowAbandon = 'jj.selection.allowAbandon',

    /** True when log selection allows merge (2+ items selected) */
    SelectionAllowMerge = 'jj.selection.allowMerge',

    /** True when selected commit(s) have at least one mutable parent */
    SelectionParentMutable = 'jj.selection.parentMutable',

    /** True when any number of commits are selected (create new commit before them) */
    SelectionAllowNewBefore = 'jj.selection.allowNewBefore',
}

/**
 * Context values assigned to SCM Resource Groups and States.
 * Evaluated against `scmResourceGroupState` and `scmResourceState` in `package.json`.
 */
export enum ScmContextValue {
    // Group States
    WorkingCopyGroup = 'jj.group.workingCopy',
    ConflictGroup = 'jj.group.conflict',
    AncestorGroup = 'jj.group.ancestor',
    AncestorGroupMutable = 'jj.group.ancestor:mutable',
    AncestorGroupSquashable = 'jj.group.ancestor:squashable',

    // Item States
    WorkingCopy = 'jj.resource.workingCopy',
    WorkingCopySquashable = 'jj.resource.workingCopy:squashable',
    Conflict = 'jj.resource.conflict',
    Ancestor = 'jj.resource.ancestor',
    AncestorSquashable = 'jj.resource.ancestor:squashable',
}
