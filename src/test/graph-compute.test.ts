/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { JjService } from '../jj-service';
import { computeGraphLayout } from '../webview/graph-compute';
import { TestRepo, buildGraph } from './test-repo';

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
        edges: { x1: number; y1: number; x2: number; y2: number; curveY?: number; isJoining?: boolean }[];
    },
    headId: string,
): string {
    const rows: string[] = [];
    const nodesById = new Map<string, { x: number; y: number; commitId: string }>(
        layout.nodes.map((n) => [n.commitId, n]),
    );

    // Calculate maximum width (number of lanes) used by any node or edge
    let width = Math.max(1, ...layout.nodes.map((n) => n.x + 1));
    for (const e of layout.edges) {
        width = Math.max(width, e.x1 + 1, e.x2 + 1);
    }

    for (let i = 0; i < layout.rows.length; i++) {
        const log = layout.rows[i];
        const node = nodesById.get(log.commit_id);
        if (!node) {
            continue;
        }

        // Pre-calculate yBend for all non-straight edges early, so both Commit Row and Spacer Rows can use it.
        const edgeRoutes = layout.edges.map((e) => {
            if (e.x1 === e.x2) return { ...e, yBend: e.y1 }; // Straight

            // jj log curves around row offsets. It typically curves just before the target
            // row `curveY`, so visual yBend is exactly midway above curveY
            return { ...e, yBend: (e.curveY ?? e.y2) - 0.5 };
        });

        // 1. Commit Row
        let lineStr = '';
        for (let x = 0; x < width; x++) {
            let symbol = ' ';
            if (node.x === x) {
                symbol = '○';
                if (log.parents.length === 0) {
                    symbol = '◆';
                }
                if (log.is_working_copy || log.change_id === headId) {
                    symbol = '@';
                }
            } else {
                const hasEdge = edgeRoutes.some((e) => {
                    // Skip edges that connect to the final root marker (no visible descendants below it in jj log)
                    if (e.y2 >= layout.rows.length - 1) return false;

                    if (e.x1 === e.x2) {
                        return e.x1 === x && Math.min(e.y1, e.y2) < node.y && Math.max(e.y1, e.y2) > node.y;
                    } else {
                        if (x === e.x1 && node.y < e.yBend && node.y > e.y1) return true;
                        if (x === e.x2 && node.y > e.yBend && node.y < e.y2 && !e.isJoining) return true;
                        return false;
                    }
                });
                if (hasEdge) symbol = '│';
            }
            lineStr += symbol;
            if (x < width - 1) {
                lineStr += ' ';
            }
        }
        // Find furthest active lane for this row to determine padding width
        let maxActiveLane = node.x;
        edgeRoutes.forEach((e) => {
            if (e.y2 >= layout.rows.length - 1) return; // Skip edges to root marker
            if (e.y1 === node.y) {
                // If an edge originates from this node (a fork), the target lane is active
                maxActiveLane = Math.max(maxActiveLane, e.x2);
            }
            if (e.x1 === e.x2) {
                if (Math.min(e.y1, e.y2) < node.y && Math.max(e.y1, e.y2) > node.y)
                    maxActiveLane = Math.max(maxActiveLane, e.x1);
            } else {
                if (node.y < e.yBend && node.y > e.y1) maxActiveLane = Math.max(maxActiveLane, e.x1);
                if (node.y > e.yBend && node.y < e.y2) maxActiveLane = Math.max(maxActiveLane, e.x2);
            }
        });

        const paddedStr = lineStr.trimEnd();
        const requiredLength = maxActiveLane * 2 + 1;
        const finalStr = paddedStr.padEnd(requiredLength, ' ');

        rows.push(`${finalStr}  ${log.change_id.substring(0, 8)} ${log.description.split('\n')[0]}`.trimEnd());

        if (log.parents.length === 0) {
            continue; // No spacer rows needed after a root commit.
        }

        // 2. Spacer Rows (2 lines)
        if (i < layout.rows.length - 1) {
            const nextLog = layout.rows[i + 1];
            const yMid = node.y + 0.5;

            // In jj log, if an empty child is connecting to the root commit, it skips the second spacer row
            // to save vertical space.
            const isStraightToRoot = nextLog.parents.length === 0 && log.description === '';
            const spacerCount = isStraightToRoot ? 1 : 2;

            for (let s = 0; s < spacerCount; s++) {
                let spacerStr = '';
                const isCurveRow = s === 0;
                let rowIsMerge = false;
                let rowIsFork = false;
                if (isCurveRow) {
                    // Check if any edge is curving at this yMid
                    const bendingEdge = edgeRoutes.find((e) => e.x1 !== e.x2 && e.yBend === yMid);

                    if (bendingEdge) {
                        if (bendingEdge.x1 > bendingEdge.x2) {
                            // Lane N merging to Lane < N

                            // Let's check if there is ALSO a straight connection passing down Lane N at yMid.
                            const laneContinues = edgeRoutes.some(
                                (e) =>
                                    e.x1 === bendingEdge.x1 &&
                                    e.y1 <= yMid - 0.5 &&
                                    ((e.x2 === bendingEdge.x1 && e.y2 > yMid) ||
                                        (e.x2 !== bendingEdge.x1 && e.yBend > yMid)),
                            );

                            // Build the spacer string column by column
                            for (let x = 0; x < width; x++) {
                                if (x === bendingEdge.x2) {
                                    // Target lane (left side of the fork/merge)
                                    spacerStr += laneContinues ? '╭' : '├';
                                } else if (x > bendingEdge.x2 && x < bendingEdge.x1) {
                                    // Intermediate lanes get crossed over
                                    spacerStr += '─';
                                } else if (x === bendingEdge.x1) {
                                    // Source lane (right side)
                                    spacerStr += laneContinues ? '┤' : '╯';
                                } else {
                                    // Lanes not involved in the bend
                                    const hasVertical = edgeRoutes.some((e) => {
                                        if (e.x1 === e.x2) {
                                            return (
                                                e.x1 === x && Math.min(e.y1, e.y2) < yMid && Math.max(e.y1, e.y2) > yMid
                                            );
                                        } else {
                                            if (x === e.x1 && yMid < e.yBend && yMid > e.y1) return true;
                                            if (x === e.x2 && yMid > e.yBend && yMid < e.y2) return true;
                                            return false;
                                        }
                                    });
                                    spacerStr += hasVertical ? '│' : ' ';
                                }
                                if (x < width - 1) {
                                    if (x >= bendingEdge.x2 && x < bendingEdge.x1) {
                                        spacerStr += '─';
                                    } else {
                                        spacerStr += ' ';
                                    }
                                }
                            }
                            rowIsFork = true; // Handled both fork and merge in the builder above
                        } else {
                            // Lane N branching from Lane < N (for completeness, e.g. ╭─┤ on the right)
                            // jj log usually pulls left, so this is rare natively but good for correctness.
                            const laneContinues = edgeRoutes.some(
                                (e) =>
                                    e.x1 === bendingEdge.x1 &&
                                    e.y1 <= yMid - 0.5 &&
                                    ((e.x2 === bendingEdge.x1 && e.y2 > yMid) ||
                                        (e.x2 !== bendingEdge.x1 && e.yBend > yMid)),
                            );

                            for (let x = 0; x < width; x++) {
                                if (x === bendingEdge.x1) {
                                    spacerStr += laneContinues ? '├' : '╰';
                                } else if (x > bendingEdge.x1 && x < bendingEdge.x2) {
                                    spacerStr += '─';
                                } else if (x === bendingEdge.x2) {
                                    spacerStr += laneContinues ? '╮' : '┤';
                                } else {
                                    const hasVertical = edgeRoutes.some((e) => {
                                        if (e.x1 === e.x2) {
                                            return (
                                                e.x1 === x && Math.min(e.y1, e.y2) < yMid && Math.max(e.y1, e.y2) > yMid
                                            );
                                        } else {
                                            if (x === e.x1 && yMid < e.yBend && yMid > e.y1) return true;
                                            if (x === e.x2 && yMid > e.yBend && yMid < e.y2) return true;
                                            return false;
                                        }
                                    });
                                    spacerStr += hasVertical ? '│' : ' ';
                                }
                                if (x < width - 1) {
                                    if (x >= bendingEdge.x1 && x < bendingEdge.x2) {
                                        spacerStr += '─';
                                    } else {
                                        spacerStr += ' ';
                                    }
                                }
                            }
                            rowIsFork = true;
                        }
                    }
                }

                if (!rowIsMerge && !rowIsFork) {
                    for (let x = 0; x < width; x++) {
                        const hasVertical = edgeRoutes.some((e) => {
                            if (e.x1 === e.x2) {
                                return e.x1 === x && Math.min(e.y1, e.y2) < yMid && Math.max(e.y1, e.y2) > yMid;
                            } else {
                                // Diagonal edge: occupies x1 before yBend, and x2 after yBend
                                if (x === e.x1 && yMid < e.yBend && yMid > e.y1) return true;
                                if (x === e.x2 && yMid >= e.yBend && yMid < e.y2 && !e.isJoining) return true;
                                return false;
                            }
                        });
                        spacerStr += hasVertical ? '│' : ' ';
                        if (x < width - 1) {
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
    });

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

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, headId).trim();

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
    });

    test('Even More Complex Replay', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'Base', parents: ['root()'] },
            { label: 'main', description: 'Main', parents: ['base'] },
            { label: 'side', description: 'Side', parents: ['base'] },
            { label: 'merge', description: 'Merge', parents: ['main', 'side'] },
            { label: 'chain', description: 'Chain', parents: ['merge'] },
            { label: 'branch', description: 'Branch', parents: ['main'] },
            { label: 'wc', description: 'WC', parents: ['main'], isWorkingCopy: true },
        ]);

        const logs = await jjService.getLog();
        const layout = computeGraphLayout(logs);

        const headLog = logs.find((l) => l.is_working_copy);
        const headId = headLog ? headLog.change_id : '';

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, headId).trim();

        expect(generatedOutput).toBe(expectedOutput);
    });

    test('Deep Nesting Multi-Lane Replay', async () => {
        // Build the graph using buildGraph in historical order
        await buildGraph(repo, [
            { label: 'lvtk', description: 'the root' },
            { label: 'zonk', description: 'A', parents: ['lvtk'] },
            { label: 'vqpn', description: 'testing: feature A', parents: ['lvtk'] },
            { label: 'kppt', description: 'This is a house on a street', parents: ['vqpn', 'zonk'] },
            { label: 'lrnm', description: 'lrnm', parents: ['kppt'] },
            { label: 'rtox', description: 'rtox', parents: ['kppt'] },
            { label: 'posk', description: 'This is a tree', parents: ['rtox'] },
            { label: 'smyx', description: 'Wow! It worked again, for realzies', parents: ['posk'] },
            { label: 'plko', description: 'plko', parents: ['lrnm'] },
            { label: 'mnry', description: 'mnry', parents: ['plko'] },
            { label: 'txmw', description: 'Things', parents: ['plko'] },
            { label: 'yukr', description: 'yukr', parents: ['smyx'] },
            { label: 'mpsp', description: 'testing child: feature B', parents: ['vqpn'] },
            { label: 'vxmy', description: 'vxmy', parents: ['yukr'] },
            { label: 'uoym', description: 'uoym', parents: ['zonk'], isWorkingCopy: true },
        ]);

        const jjService = new JjService(repo.path);
        const logs = await jjService.getLog();
        const layout = computeGraphLayout(logs);

        const headLog = logs.find((l) => l.is_working_copy);
        const headId = headLog ? headLog.change_id : '';

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, headId).trim();

        expect(generatedOutput).toBe(expectedOutput);
    });

    test('Multiple Children Curve Routing (Stack Layout Fix)', async () => {
        // Setup:
        // Root -> P
        // P -> A
        // P -> B
        // P -> C
        await buildGraph(repo, [
            { label: 'root', description: 'Root' },
            { label: 'p', description: 'P', parents: ['root'] },
            { label: 'a', description: 'A', parents: ['p'] },
            { label: 'b', description: 'B', parents: ['p'] },
            { label: 'c', description: 'C', parents: ['p'], isWorkingCopy: true },
        ]);

        const logs = await jjService.getLog();
        const layout = computeGraphLayout(logs);

        const headLog = logs.find((l) => l.is_working_copy);
        const headId = headLog ? headLog.change_id : '';

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, headId).trim();

        expect(generatedOutput).toBe(expectedOutput);
    });

    test('Complex Overlapping Multi-Child Layout (Issue with lanes assigned incorrectly)', async () => {
        await buildGraph(repo, [
            { label: 'lv', description: 'lv' },
            { label: 'vq', description: 'vq', parents: ['lv'] },
            { label: 'mp', description: 'mp', parents: ['vq'] },
            { label: 'xn', description: 'xn', parents: ['lv'] },
            { label: 'yz', description: 'yz', parents: ['lv'] },
            { label: 'on', description: 'on', parents: ['lv'] },
            { label: 'zo', description: 'zo', parents: ['lv'] },
            { label: 'kp', description: 'kp', parents: ['vq', 'zo'] },
            { label: 'lr', description: 'lr', parents: ['kp'] },
            { label: 'pl', description: 'pl', parents: ['lr'] },
            { label: 'mn', description: 'mn', parents: ['pl'] },
            { label: 'tx', description: 'tx', parents: ['pl'] },
            { label: 'rt', description: 'rt', parents: ['kp'] },
            { label: 'po', description: 'po', parents: ['rt'] },
            { label: 'sm', description: 'sm', parents: ['po'] },
            { label: 'yu', description: 'yu', parents: ['sm'] },
            { label: 'vx', description: 'vx', parents: ['yu'] },
            { label: 'ux', description: 'ux', parents: ['vx'] },
            { label: 'wr', description: 'wr', parents: ['ux'], isWorkingCopy: true },
        ]);

        const layout = computeGraphLayout(await jjService.getLog());
        const headId = layout.nodes[0].changeId;

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, headId).trim();

        expect(generatedOutput).toBe(expectedOutput);
    });
});
