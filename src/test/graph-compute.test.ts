/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { JjService } from '../jj-service';
import { computeGraphLayout } from '../webview/graph-compute';
import { TestRepo, buildGraph } from './test-repo';

describe('Graph Layout Integration Tests (Real jj output)', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path);
    });

    afterEach(() => {
        repo.dispose();
    });

    /*
     * Linear History Layout
     *
     * @  C2 (HEAD)
     * ○  C1
     * ○  Root
     */
    test('Linear History Layout', async () => {
        // Setup: Root -> C1 -> C2 -> HEAD
        await buildGraph(repo, [
            { label: 'root', description: 'Root' },
            { label: 'c1', description: 'C1', parents: ['root'] },
            { label: 'c2', description: 'C2', parents: ['c1'], isWorkingCopy: true },
        ]);

        const logs = await jjService.getLog();
        const layout = computeGraphLayout(logs);

        const nodes = layout.nodes;

        // Find nodes (using description to match)
        const root = nodes.find((n) => logs[n.y].description.includes('Root'));
        const forC1 = nodes.find((n) => logs[n.y].description.includes('C1'));
        const forC2 = nodes.find((n) => logs[n.y].description.includes('C2'));

        expect(root).toBeDefined();
        expect(forC1).toBeDefined();
        expect(forC2).toBeDefined();

        // Check columns (all 0)
        expect(root!.x).toBe(0);
        expect(forC1!.x).toBe(0);
        expect(forC2!.x).toBe(0);

        // Check order (C2 < C1 < Root) - Y increases downwards or simply distinct
        // computeGraphLayout typically puts HEAD at y=0 or similar
        expect(forC2!.y).toBeLessThan(forC1!.y);
        expect(forC1!.y).toBeLessThan(root!.y);

        // Check edges
        const edges = layout.edges;
        // Edge C2->C1
        const edge21 = edges.find((e) => e.y1 === forC2!.y && e.y2 === forC1!.y);
        expect(edge21).toBeDefined();
        expect(edge21!.x1).toBe(0);
        expect(edge21!.x2).toBe(0);

        // Edge C1->Root
        const edge10 = edges.find((e) => e.y1 === forC1!.y && e.y2 === root!.y);
        expect(edge10).toBeDefined();
    });

    /*
     * Fork Layout (One Parent, Two Children)
     *
     * @  Child2 (HEAD)
     * │ ○  Child1
     * ├─╯
     * ○  Parent
     * ○  Root
     */
    test('Fork Layout (One Parent, Two Children)', async () => {
        // Setup:
        // Root -> Parent
        // Parent -> Child1
        // Parent -> Child2
        await buildGraph(repo, [
            { label: 'root', description: 'Root' },
            { label: 'parent', description: 'Parent', parents: ['root'] },
            { label: 'child1', description: 'Child1', parents: ['parent'] },
            { label: 'child2', description: 'Child2', parents: ['parent'] },
        ]);

        const logs = await jjService.getLog();
        const layout = computeGraphLayout(logs);

        const nodes = layout.nodes;
        const parent = nodes.find((n) => logs[n.y].description.includes('Parent'));
        const child1 = nodes.find((n) => logs[n.y].description.includes('Child1'));
        const child2 = nodes.find((n) => logs[n.y].description.includes('Child2'));

        expect(parent).toBeDefined();
        expect(child1).toBeDefined();
        expect(child2).toBeDefined();

        // Children strictly above parent
        expect(child1!.y).toBeLessThan(parent!.y);
        expect(child2!.y).toBeLessThan(parent!.y);

        // Children in different columns
        expect(child1!.x).not.toBe(child2!.x);

        // Edges from children to parent
        const edge1 = layout.edges.find(
            (e) => (e.y1 === child1!.y && e.y2 === parent!.y) || (e.y2 === child1!.y && e.y1 === parent!.y),
        );
        const edge2 = layout.edges.find(
            (e) => (e.y1 === child2!.y && e.y2 === parent!.y) || (e.y2 === child2!.y && e.y1 === parent!.y),
        );
        expect(edge1).toBeDefined();
        expect(edge2).toBeDefined();
    });

    /*
     * Merge Layout (Two Parents, One Child)
     *
     * @    MergeChild
     * ├─╮
     * │ ○  P2
     * ○ │  P1
     * ├─╯
     * ○    Root
     */
    test('Merge Layout (Two Parents, One Child)', async () => {
        // Setup:
        // Root -> P1
        // Root -> P2
        // Merge (P1, P2) -> Child

        await buildGraph(repo, [
            { label: 'root', description: 'Root' },
            { label: 'p1', description: 'P1', parents: ['root'] },
            { label: 'p2', description: 'P2', parents: ['root'] },
            { label: 'merge', description: 'MergeChild', parents: ['p1', 'p2'] },
        ]);

        const logs = await jjService.getLog();
        const layout = computeGraphLayout(logs);

        const mergeNode = layout.nodes.find((n) => logs[n.y].description.includes('MergeChild'));
        const p1Node = layout.nodes.find((n) => logs[n.y].description.includes('P1'));
        const p2Node = layout.nodes.find((n) => logs[n.y].description.includes('P2'));

        expect(mergeNode).toBeDefined();
        expect(p1Node).toBeDefined();
        expect(p2Node).toBeDefined();

        // Merge should connect to P1 and P2
        const e1 = layout.edges.find((e) => e.y1 === mergeNode!.y && e.y2 === p1Node!.y);
        const e2 = layout.edges.find((e) => e.y1 === mergeNode!.y && e.y2 === p2Node!.y);

        expect(e1).toBeDefined();
        expect(e2).toBeDefined();

        // P1 and P2 should be in different lanes
        if (p1Node!.y === p2Node!.y) {
            expect(p1Node!.x).not.toBe(p2Node!.x);
        }
    }, 20000);

    test('Complex Replay (Reproduce User Scenario)', async () => {
        // Reproduce:
        // @  tqlynzyq (HEAD)
        // │
        // ○  vpmososp
        // │
        // │ ○  luulxmlm (Orcs)
        // ├─╯
        // ○  xyonkpvt (Cool)
        // │
        // │ ○  xzyrzuon (CC)
        // │ │
        // │ ○  xqotpwsy (Fake TS)
        // ├─╯
        // ○  onppknuy (Initial)
        // ◆  Root

        await buildGraph(repo, [
            { label: 'initial', description: 'initial commit', parents: ['root()'] },
            // Fork 1: Fake TS
            { label: 'fakeTS', description: 'Added a fake ts file', parents: ['initial'] },
            { label: 'cc', description: 'cc file and stuff', parents: ['fakeTS'] },
            // Fork 2: Cool
            { label: 'cool', description: "It's pretty cool I guess", parents: ['initial'] },
            { label: 'vpm', description: 'vpmososp', parents: ['cool'] },
            // Fork 3: Orcs (from Cool)
            { label: 'orcs', description: 'Orcs are coming', parents: ['cool'] },
            // HEAD (from vpm)
            { label: 'head', description: 'tqlynzyq', parents: ['vpm'], isWorkingCopy: true },
        ]);

        const logs = await jjService.getLog();
        const layout = computeGraphLayout(logs);

        // NOTE: We need to manually calculate headId because renderToAscii relied on it being in scope/verified.
        // The logs array has change_id, we can find the one with is_working_copy.
        const headLog = logs.find((l) => l.is_working_copy);
        const headId = headLog ? headLog.change_id : '';

        // Helper: ASCII renderer to verify layout against jj log output
        function renderToAscii(
            layout: {
                nodes: { x: number; y: number; commitId: string }[];
                rows: {
                    commit_id: string;
                    parents: string[];
                    is_working_copy?: boolean;
                    change_id: string;
                    description: string;
                }[];
                edges: { x1: number; y1: number; x2: number; y2: number }[];
            },
            _logs: unknown[],
        ): string {
            const rows: string[] = [];
            const nodesById = new Map<string, { x: number; y: number; commitId: string }>(
                layout.nodes.map((n) => [n.commitId, n]),
            );

            for (let i = 0; i < layout.rows.length; i++) {
                const log = layout.rows[i];
                const node = nodesById.get(log.commit_id);
                if (!node) {
                    continue;
                }

                // 1. Commit Row
                let lineStr = '';
                for (let x = 0; x <= 1; x++) {
                    if (node.x === x) {
                        let symbol = '○';
                        if (log.parents.length === 0) {
                            symbol = '◆';
                        }
                        if (log.is_working_copy || log.change_id === headId) {
                            symbol = '@';
                        }
                        lineStr += symbol;
                    } else {
                        const hasEdge = layout.edges.some(
                            (e) =>
                                e.x1 === x &&
                                e.x2 === x &&
                                Math.min(e.y1, e.y2) < node.y &&
                                Math.max(e.y1, e.y2) > node.y,
                        );
                        lineStr += hasEdge ? '│' : ' ';
                    }
                    if (x < 1) {
                        lineStr += ' ';
                    }
                }
                while (lineStr.length < 3) {
                    lineStr += ' ';
                }
                rows.push(`${lineStr.trimEnd()}  ${log.change_id.substring(0, 8)} ${log.description.split('\n')[0]}`);

                // 2. Spacer Rows (2 lines)
                if (i < layout.rows.length - 1) {
                    const nextLog = layout.rows[i + 1];
                    const nextNode = nodesById.get(nextLog.commit_id);
                    const yMid = node.y + 0.5;

                    for (let s = 0; s < 2; s++) {
                        let spacerStr = '';
                        const isCurveRow = s === 0;
                        let rowIsMerge = false;

                        // Check 1->0 Merge Connector (├─╯)
                        if (isCurveRow && node && nextNode && node.x === 1 && nextNode.x === 0) {
                            const edge = layout.edges.find(
                                (e) =>
                                    (e.y1 === node.y && e.y2 === nextNode.y) ||
                                    (e.y2 === node.y && e.y1 === nextNode.y),
                            );
                            if (edge) {
                                const verticalOn0 = layout.edges.some(
                                    (e) =>
                                        e.x1 === 0 &&
                                        e.x2 === 0 &&
                                        Math.min(e.y1, e.y2) < nextNode.y &&
                                        Math.max(e.y1, e.y2) >= node.y,
                                );
                                if (verticalOn0) {
                                    spacerStr = '├─╯';
                                    rowIsMerge = true;
                                }
                            }
                        }

                        if (!rowIsMerge) {
                            for (let x = 0; x <= 1; x++) {
                                const hasVertical = layout.edges.some(
                                    (e) =>
                                        e.x1 === x &&
                                        e.x2 === x &&
                                        Math.min(e.y1, e.y2) < yMid &&
                                        Math.max(e.y1, e.y2) > yMid,
                                );
                                spacerStr += hasVertical ? '│' : ' ';
                                if (x < 1) {
                                    spacerStr += ' ';
                                }
                            }
                        }
                        rows.push(spacerStr.trimEnd());
                    }
                }
            }
            return rows.join('\n');
        }

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, logs).trim();

        expect(generatedOutput).toBe(expectedOutput);

        // Match specific known characteristic we expect
        // e.g. "Orcs are coming" should be on a specific row

        // Initial
        const initial = layout.nodes.find((n) => logs[n.y].description.includes('initial commit'));
        expect(initial).toBeDefined();

        // Cool Guess (Child of Initial)
        const cool = layout.nodes.find((n) => logs[n.y].description.includes("It's pretty cool I guess"));
        expect(cool).toBeDefined();

        // Fake TS (Child of Initial)
        const fakeTSNode = layout.nodes.find((n) => logs[n.y].description.includes('fake ts'));
        expect(fakeTSNode).toBeDefined();

        // Verify Fork at Initial
        // cool.y < initial.y (cool is newer/higher)
        expect(cool!.y).toBeLessThan(initial!.y);
        expect(fakeTSNode!.y).toBeLessThan(initial!.y);

        // Ensure different lanes
        expect(cool!.x).not.toBe(fakeTSNode!.x);

        // CC (Child of Fake TS)
        const cc = layout.nodes.find((n) => logs[n.y].description.includes('cc file'));
        expect(cc).toBeDefined();
        // CC should be above Fake TS
        expect(cc!.y).toBeLessThan(fakeTSNode!.y);
        // CC should be in same lane as Fake TS (standard behavior)
        expect(cc!.x).toBe(fakeTSNode!.x);

        // Orcs (Child of Cool)
        const orcs = layout.nodes.find((n) => logs[n.y].description.includes('Orcs'));
        expect(orcs).toBeDefined();

        // vpmososp (Child of Cool)
        const vpm = layout.nodes.find((n) => logs[n.y].description.includes('vpmososp'));
        expect(vpm).toBeDefined();

        // Verify Fork at Cool
        expect(orcs!.y).toBeLessThan(cool!.y);
        expect(vpm!.y).toBeLessThan(cool!.y);
        expect(orcs!.x).not.toBe(vpm!.x);

        // HEAD (Child of vpm)
        const head = layout.nodes.find((n) => logs[n.y].description.includes('tqlynzyq'));
        expect(head).toBeDefined();
        expect(head!.y).toBeLessThan(vpm!.y);
    });
});
