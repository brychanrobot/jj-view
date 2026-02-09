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
}
