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

    /** Mirrors the jj-view.openDiffOnClick setting; controls inline button visibility */
    OpenDiffOnClick = 'jj.openDiffOnClick',
}

/**
 * Context values used as `SourceControlResourceGroup.contextValue` (ScmContextValue.Group*)
 * or `SourceControlResourceState.contextValue` (ScmContextValue.Resource*).
 *
 * For SCM Resource States, the contextValue contains a space-separated list of capability keys
 * (e.g. "jj.resource.allowRestore jj.resource.allowOpen"), and package.json matches them via regex
 * like `scmResourceState =~ /\bjj\.resource\.allowRestore\b/`.
 */
export enum ScmContextValue {
    // SCM Resource Group IDs
    WorkingCopyGroup = 'jj.group.workingCopy',
    ConflictGroup = 'jj.group.conflict',

    // SCM Resource Group Capabilities
    GroupAllowShowMultiFileDiff = 'jj.group.allowShowMultiFileDiff',
    GroupAllowShowDetails = 'jj.group.allowShowDetails',
    GroupAllowEdit = 'jj.group.allowEdit',
    GroupAllowSquash = 'jj.group.allowSquash',
    GroupAllowAbsorb = 'jj.group.allowAbsorb',
    GroupAllowAbandon = 'jj.group.allowAbandon',

    // SCM Resource Item Capabilities
    ResourceAllowRestore = 'jj.resource.allowRestore',
    ResourceAllowSquashIntoParent = 'jj.resource.allowSquashIntoParent',
    ResourceAllowSquashIntoAncestor = 'jj.resource.allowSquashIntoAncestor',
    ResourceAllowSquashIntoChild = 'jj.resource.allowSquashIntoChild',
    ResourceAllowOpen = 'jj.resource.allowOpen',
    ResourceAllowOpenMergeEditor = 'jj.resource.allowOpenMergeEditor',
}
