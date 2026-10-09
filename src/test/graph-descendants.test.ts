/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { computeDescendantCounts } from '../core/webview/log/utils/graph-descendants';
import { buildGraph, TestRepo } from './test-repo';

describe('computeDescendantCounts', () => {
    let repo: TestRepo;
    let jj: JjService;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
    });

    it('computes descendant counts in a linear stack', async () => {
        // Root -> A -> B -> C -> D
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'a', parents: ['root'], description: 'A' },
            { label: 'b', parents: ['a'], description: 'B' },
            { label: 'c', parents: ['b'], description: 'C' },
            { label: 'd', parents: ['c'], description: 'D' },
        ]);

        const commits = await jj.getLog({});
        const counts = computeDescendantCounts(commits);

        expect(counts.get(ids.d.changeId)).toBe(0);
        expect(counts.get(ids.c.changeId)).toBe(1);
        expect(counts.get(ids.b.changeId)).toBe(2);
        expect(counts.get(ids.a.changeId)).toBe(3);
    });

    it('computes descendant counts across branching histories', async () => {
        // Root -> A
        // A -> B -> C
        // A -> D -> E
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'a', parents: ['root'], description: 'A' },
            { label: 'b', parents: ['a'], description: 'B' },
            { label: 'c', parents: ['b'], description: 'C' },
            { label: 'd', parents: ['a'], description: 'D' },
            { label: 'e', parents: ['d'], description: 'E' },
        ]);

        const commits = await jj.getLog({});
        const counts = computeDescendantCounts(commits);

        expect(counts.get(ids.c.changeId)).toBe(0);
        expect(counts.get(ids.e.changeId)).toBe(0);
        expect(counts.get(ids.b.changeId)).toBe(1);
        expect(counts.get(ids.d.changeId)).toBe(1);
        expect(counts.get(ids.a.changeId)).toBe(4);
    });

    it('handles diamond merge topologies without double counting', async () => {
        // Root -> A
        // A -> B
        // A -> C
        // B, C -> D (merge)
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'a', parents: ['root'], description: 'A' },
            { label: 'b', parents: ['a'], description: 'B' },
            { label: 'c', parents: ['a'], description: 'C' },
            { label: 'd', parents: ['b', 'c'], description: 'D' },
        ]);

        const commits = await jj.getLog({});
        const counts = computeDescendantCounts(commits);

        expect(counts.get(ids.d.changeId)).toBe(0);
        expect(counts.get(ids.b.changeId)).toBe(1);
        expect(counts.get(ids.c.changeId)).toBe(1);
        // A's descendants are B, C, D (3 unique commits)
        expect(counts.get(ids.a.changeId)).toBe(3);
    });
});
