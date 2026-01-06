// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
}
