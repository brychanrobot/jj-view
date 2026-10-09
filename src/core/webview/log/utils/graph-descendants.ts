/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JjLogEntry } from '../../../jj-types';

/**
 * Computes the count of transitive descendants for each commit in the visible graph.
 *
 * @param commits List of log entries visible in the log view.
 * @returns Map from commit change_id to the count of its descendants within the visible graph.
 */
export function computeDescendantCounts(commits: readonly JjLogEntry[]): Map<string, number> {
    const commitIdToChangeId = new Map<string, string>();
    for (const c of commits) {
        commitIdToChangeId.set(c.commit_id, c.change_id);
    }

    const childrenMap = new Map<string, Set<string>>();
    for (const c of commits) {
        for (const p of c.parents) {
            const parentChangeId = p.change_id || commitIdToChangeId.get(p.commit_id);
            if (parentChangeId) {
                let children = childrenMap.get(parentChangeId);
                if (!children) {
                    children = new Set<string>();
                    childrenMap.set(parentChangeId, children);
                }
                children.add(c.change_id);
            }
        }
    }

    const result = new Map<string, number>();
    for (const c of commits) {
        const visited = new Set<string>();
        const queue: string[] = [c.change_id];
        let head = 0;
        while (head < queue.length) {
            const current = queue[head++];
            const children = childrenMap.get(current);
            if (children) {
                for (const child of children) {
                    if (child !== c.change_id && !visited.has(child)) {
                        visited.add(child);
                        queue.push(child);
                    }
                }
            }
        }
        result.set(c.change_id, visited.size);
    }

    return result;
}
