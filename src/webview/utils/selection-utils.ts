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
 * Utility functions for handling commit selection state in the webview.
 */

// Basic interface for what we need from a commit
export interface SelectableCommit {
    change_id: string;
    is_immutable: boolean;
}

/**
 * Calculates the next set of selected commit IDs based on the user's action.
 *
 * @param currentSelection The current set of selected commit IDs.
 * @param commitId The ID of the commit being interacted with.
 * @param multiSelect Whether the interaction should toggle/add (Ctrl/Cmd click) or set exclusive.
 * @returns A new Set containing the updated selection.
 */
export function calculateNextSelection(
    currentSelection: Set<string>,
    commitId: string,
    multiSelect: boolean,
): Set<string> {
    const nextSelectedIds = new Set(currentSelection);

    if (multiSelect) {
        // Toggle behavior
        if (nextSelectedIds.has(commitId)) {
            nextSelectedIds.delete(commitId);
        } else {
            nextSelectedIds.add(commitId);
        }
    } else {
        // Exclusive select behavior
        // If clicking the ONLY item that is already selected, deselect it (toggle off)
        if (nextSelectedIds.size === 1 && nextSelectedIds.has(commitId)) {
            nextSelectedIds.clear();
        } else {
            nextSelectedIds.clear();
            nextSelectedIds.add(commitId);
        }
    }

    return nextSelectedIds;
}

/**
 * Checks if any of the selected commits are immutable.
 *
 * @param selectedIds The set of selected commit IDs.
 * @param commits The list of all available commits to look up details.
 * @returns True if at least one selected commit is immutable, false otherwise.
 */
export function hasImmutableSelection(selectedIds: Set<string>, commits: SelectableCommit[]): boolean {
    return Array.from(selectedIds).some((id) => {
        const commit = commits.find((c) => c.change_id === id);
        return commit ? commit.is_immutable : false;
    });
}
