/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService } from '../jj-service';
import type { JjLogEntry } from '../jj-types';
import { computeGraphLayout } from '../webview/graph-compute';
import { type GraphLayout, type GraphNode, isElisionRow } from '../webview/graph-model';
import { buildGraph, TestRepo } from './test-repo';

// Helper: ASCII renderer to verify layout against jj log output
function renderToAscii(layout: GraphLayout, headId: string): string {
    const rows: string[] = [];
    const nodesById = new Map<string, GraphNode>(layout.nodes.map((n: GraphNode) => [n.changeId, n]));

    const width = layout.width;

    const childDegree = new Map<string, number>();
    const parentDegree = new Map<string, number>();

    layout.rows.forEach((row) => {
        if (!isElisionRow(row)) {
            const parents = row.nearest_visible_ancestors || row.parents.map((p) => p.change_id);
            if (parents.length > 1) {
                childDegree.set(row.change_id, parents.length);
            }
            parents.forEach((p) => {
                parentDegree.set(p, (parentDegree.get(p) || 0) + 1);
            });
        }
    });

    const edgeRoutes = layout.edges.map((e) => {
        const p1 = e.points[0];
        const p2 = e.points[e.points.length - 1];
        const x1 = p1.x;
        const x2 = p2.x;

        const parts = e.id.split('->');
        const childId = parts[0];
        const parentId = parts[1];
        const cleanChildId = childId.startsWith('elided-') ? childId.substring(7) : childId;
        const cleanParentId = parentId.startsWith('elided-') ? parentId.substring(7) : parentId;

        const childNode = nodesById.get(cleanChildId);
        const parentNode = nodesById.get(cleanParentId);

        const y1 = childNode ? childNode.y : Math.floor(p1.y);
        const y2 = parentNode ? parentNode.y : Math.floor(p2.y);

        let yBend = y1;
        for (let j = 1; j < e.points.length; j++) {
            if (e.points[j].x !== x1) {
                yBend = e.points[j].y;
                break;
            }
        }

        return { ...e, x1, y1, x2, y2, yBend };
    });

    for (let i = 0; i < layout.rows.length; i++) {
        const row = layout.rows[i];

        if ('type' in row && row.type === 'elision') {
            // 0. Elision Row (~)
            let lineStr = '';
            for (let x = 0; x < width; x++) {
                let symbol = ' ';
                const hasEdge = edgeRoutes.some((e) => {
                    const isOurElision = e.isElided && e.y1 === i - 1 && (e.x1 === x || e.x2 === x);
                    if (isOurElision) {
                        symbol = '~';
                        return true;
                    }
                    if (e.x1 === e.x2) {
                        return e.x1 === x && e.y1 < i && e.y2 > i;
                    } else {
                        if (x === e.x1 && i < e.yBend && i > e.y1) {
                            return true;
                        }
                        if (x === e.x2 && i > e.yBend && i < e.y2 && !e.isJoining) {
                            return true;
                        }
                        return false;
                    }
                });
                if (hasEdge && symbol === ' ') {
                    symbol = '│';
                }
                lineStr += symbol;
                if (x < width - 1) {
                    lineStr += ' ';
                }
            }
            rows.push(lineStr.trimEnd());
            continue;
        }

        const log = row as JjLogEntry;
        const node = nodesById.get(log.change_id);
        if (!node) {
            continue;
        }

        // 1. Commit Row
        let lineStr = '';
        for (let x = 0; x < width; x++) {
            let symbol = ' ';
            if (node.x === x) {
                symbol = '○';
                if ((log.nearest_visible_ancestors || log.parents).length === 0) {
                    symbol = '◆';
                }
                if (log.is_current_working_copy || log.change_id === headId) {
                    symbol = '@';
                }
            } else {
                const hasEdge = edgeRoutes.some((e) => {
                    // Skip edges that connect to the final root marker (no visible descendants below it in jj log)
                    if (e.y2 >= layout.rows.length - 1) {
                        return false;
                    }

                    if (e.x1 === e.x2) {
                        return e.x1 === x && Math.min(e.y1, e.y2) < node.y && Math.max(e.y1, e.y2) > node.y;
                    } else {
                        if (x === e.x1 && node.y < e.yBend && node.y > e.y1) {
                            return true;
                        }
                        if (x === e.x2 && node.y > e.yBend && node.y < e.y2 && !e.isJoining) {
                            return true;
                        }
                        return false;
                    }
                });
                if (hasEdge) {
                    symbol = '│';
                }
            }
            lineStr += symbol;
            if (x < width - 1) {
                lineStr += ' ';
            }
        }
        // Find furthest active lane for this row to determine padding width
        let maxActiveLane = node.x;
        edgeRoutes.forEach((e) => {
            if (e.y2 >= layout.rows.length - 1) {
                return; // Skip edges to root marker
            }
            if (e.y1 === node.y) {
                // If an edge originates from this node (a fork), the target lane is active
                maxActiveLane = Math.max(maxActiveLane, e.x2);
            }
            if (e.x1 === e.x2) {
                if (Math.min(e.y1, e.y2) < node.y && Math.max(e.y1, e.y2) > node.y) {
                    maxActiveLane = Math.max(maxActiveLane, e.x1);
                }
            } else {
                if (node.y < e.yBend && node.y > e.y1) {
                    maxActiveLane = Math.max(maxActiveLane, e.x1);
                }
                if (node.y > e.yBend && node.y < e.y2) {
                    maxActiveLane = Math.max(maxActiveLane, e.x2);
                }
            }
        });

        const paddedStr = lineStr.trimEnd();
        const requiredLength = maxActiveLane * 2 + 1;
        const finalStr = paddedStr.padEnd(requiredLength, ' ');

        rows.push(`${finalStr}  ${log.change_id.substring(0, 8)} ${log.description.split('\n')[0]}`.trimEnd());

        if ((log.nearest_visible_ancestors || log.parents).length === 0) {
            continue; // No spacer rows needed after a root commit.
        }

        // 2. Spacer Rows (2 lines)
        if (i < layout.rows.length - 1) {
            const nextRow = layout.rows[i + 1];
            if ('type' in nextRow && nextRow.type === 'elision') {
                continue; // Skip spacers if an elision row follows
            }

            const nextLog = nextRow as JjLogEntry;

            // In jj log, if an empty child is connecting to the root commit, it skips the second spacer row
            // to save vertical space.
            const isStraightToRoot =
                (nextLog.nearest_visible_ancestors || nextLog.parents).length === 0 && log.description === '';
            const spacerCount = isStraightToRoot ? 1 : 2;

            for (let s = 0; s < spacerCount; s++) {
                let spacerStr = '';
                // Both spacer rows query at the link-row y-coordinate (node.y + 0.5).
                // Edge points use this exact coordinate for horizontal transitions.
                const yQ = node.y + 0.5;

                for (let x = 0; x < width; x++) {
                    // For the second spacer row (s=1), only show vertical pass-throughs.
                    if (s === 1) {
                        let hasDown = false;
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            for (let j = 0; j < e.points.length - 1; j++) {
                                const pA = e.points[j];
                                const pB = e.points[j + 1];
                                if (pA.x === x && pB.x === x) {
                                    if (Math.min(pA.y, pB.y) <= yQ && Math.max(pA.y, pB.y) > yQ) {
                                        hasDown = true;
                                    }
                                }
                            }
                        });
                        spacerStr += hasDown ? '│' : ' ';
                        if (x < width - 1) {
                            spacerStr += ' ';
                        }
                        continue;
                    }

                    // First spacer row (s=0): detect up/down/left/right at each cell.
                    let up = false;
                    let down = false;
                    let left = false;
                    let right = false;

                    edgeRoutes.forEach((e) => {
                        if (e.y1 > yQ || e.y2 < yQ) {
                            return;
                        }

                        for (let j = 0; j < e.points.length - 1; j++) {
                            const pA = e.points[j];
                            const pB = e.points[j + 1];

                            // Vertical segments at this column
                            if (pA.x === x && pB.x === x) {
                                if (Math.min(pA.y, pB.y) < yQ && Math.max(pA.y, pB.y) >= yQ) {
                                    up = true;
                                }
                                if (Math.min(pA.y, pB.y) <= yQ && Math.max(pA.y, pB.y) > yQ) {
                                    down = true;
                                }
                            }

                            // Horizontal segments at yQ
                            if (pA.y === yQ && pB.y === yQ) {
                                const minX = Math.min(pA.x, pB.x);
                                const maxX = Math.max(pA.x, pB.x);
                                if (minX < x && maxX >= x) {
                                    left = true;
                                }
                                if (minX <= x && maxX > x) {
                                    right = true;
                                }
                            }
                        }
                    });

                    // Calculate independent vertical based on symmetric geometric rules:
                    // A curved symbol (╭ or ╮) is used instead of a T-junction (├ or ┤)
                    // ONLY when it's the target of a curve whose source lane continues.
                    let hasIndependentVertical = true;

                    if (right && !left) {
                        // Left Endpoint: check if it's the target of a leftward curve whose source continues.
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            const childX = e.points[0].x;
                            if (childX > x) {
                                // Must actually have a horizontal segment at yQ touching x
                                const hasHorizAtX = e.points.some((p) => p.y === yQ && p.x === x);
                                if (!hasHorizAtX) {
                                    return;
                                }

                                // Found a leftward curve from childX to x.
                                // Now check if the lane at childX continues below yQ.
                                const sourceContinues = edgeRoutes.some((e_other) => {
                                    if (e_other.y1 > yQ || e_other.y2 < yQ) {
                                        return false;
                                    }
                                    if (e_other === e) {
                                        return false;
                                    }
                                    for (let j = 0; j < e_other.points.length - 1; j++) {
                                        const pA = e_other.points[j];
                                        const pB = e_other.points[j + 1];
                                        if (
                                            pA.x === childX &&
                                            pB.x === childX &&
                                            Math.min(pA.y, pB.y) <= yQ &&
                                            Math.max(pA.y, pB.y) > yQ
                                        ) {
                                            return true;
                                        }
                                    }
                                    return false;
                                });
                                if (sourceContinues) {
                                    hasIndependentVertical = false;
                                }
                            }
                        });
                    } else if (left && !right) {
                        // Right Endpoint: check if it's the target of a rightward curve whose source continues.
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            const childX = e.points[0].x;
                            if (childX < x) {
                                // Must actually have a horizontal segment at yQ touching x
                                const hasHorizAtX = e.points.some((p) => p.y === yQ && p.x === x);
                                if (!hasHorizAtX) {
                                    return;
                                }

                                // Found a rightward curve from childX to x.
                                // Now check if the lane at childX continues below yQ.
                                const sourceContinues = edgeRoutes.some((e_other) => {
                                    if (e_other.y1 > yQ || e_other.y2 < yQ) {
                                        return false;
                                    }
                                    if (e_other === e) {
                                        return false;
                                    }
                                    for (let j = 0; j < e_other.points.length - 1; j++) {
                                        const pA = e_other.points[j];
                                        const pB = e_other.points[j + 1];
                                        if (
                                            pA.x === childX &&
                                            pB.x === childX &&
                                            Math.min(pA.y, pB.y) <= yQ &&
                                            Math.max(pA.y, pB.y) > yQ
                                        ) {
                                            return true;
                                        }
                                    }
                                    return false;
                                });
                                if (sourceContinues) {
                                    hasIndependentVertical = false;
                                }
                            }
                        });
                    }

                    let symbol = ' ';
                    if (up && down && !left && !right) {
                        symbol = '│';
                    } else if (left && right) {
                        symbol = '─';
                    } else if (up && down && right && !left) {
                        symbol = hasIndependentVertical ? '├' : '╭';
                    } else if (up && down && left && !right) {
                        symbol = hasIndependentVertical ? '┤' : '╮';
                    } else if (!up && down && !left && right) {
                        symbol = '╭';
                    } else if (!up && down && left && !right) {
                        symbol = '╮';
                    } else if (up && !down && !left && right) {
                        symbol = '╰';
                    } else if (up && !down && left && !right) {
                        symbol = '╯';
                    } else if ((up || down) && !left && !right) {
                        symbol = '│';
                    } else if (!up && !down && (left || right)) {
                        symbol = '─';
                    }

                    spacerStr += symbol;

                    if (x < width - 1) {
                        let spaceHasHoriz = false;
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            for (let j = 0; j < e.points.length - 1; j++) {
                                const pA = e.points[j];
                                const pB = e.points[j + 1];
                                if (
                                    pA.y === yQ &&
                                    pB.y === yQ &&
                                    Math.min(pA.x, pB.x) <= x &&
                                    Math.max(pA.x, pB.x) >= x + 1
                                ) {
                                    spaceHasHoriz = true;
                                    break;
                                }
                            }
                        });
                        spacerStr += spaceHasHoriz ? '─' : ' ';
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
            { label: 'c2', description: 'C2', parents: ['c1'], isCurrentWorkingCopy: true },
        ]);

        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
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
        expect(root?.x).toBe(0);
        expect(forC1?.x).toBe(0);
        expect(forC2?.x).toBe(0);

        // Check order (C2 < C1 < Root) - Y increases downwards or simply distinct
        // computeGraphLayout typically puts HEAD at y=0 or similar
        expect(forC2?.y).toBeLessThan(forC1?.y as number);
        expect(forC1?.y).toBeLessThan(root?.y as number);

        // Check edges
        const edges = layout.edges;
        // Edge C2->C1
        const edge21 = edges.find(
            (e) => Math.floor(e.points[0].y) === forC2?.y && Math.floor(e.points[e.points.length - 1].y) === forC1?.y,
        );
        expect(edge21).toBeDefined();
        expect(edge21?.points[0].x).toBe(0);
        expect(edge21?.points[edge21.points.length - 1].x).toBe(0);

        // Edge C1->Root
        const edge10 = edges.find(
            (e) => Math.floor(e.points[0].y) === forC1?.y && Math.floor(e.points[e.points.length - 1].y) === root?.y,
        );
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

        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
        const layout = computeGraphLayout(logs);

        const nodes = layout.nodes;
        const parent = nodes.find((n) => logs[n.y].description.includes('Parent'));
        const child1 = nodes.find((n) => logs[n.y].description.includes('Child1'));
        const child2 = nodes.find((n) => logs[n.y].description.includes('Child2'));

        expect(parent).toBeDefined();
        expect(child1).toBeDefined();
        expect(child2).toBeDefined();

        // Children strictly above parent
        expect(child1?.y).toBeLessThan(parent?.y as number);
        expect(child2?.y).toBeLessThan(parent?.y as number);

        // Children in different columns
        expect(child1?.x).not.toBe(child2?.x);

        // Edges from children to parent
        const edge1 = layout.edges.find(
            (e) =>
                (Math.floor(e.points[0].y) === child1?.y &&
                    Math.floor(e.points[e.points.length - 1].y) === parent?.y) ||
                (Math.floor(e.points[e.points.length - 1].y) === child1?.y && Math.floor(e.points[0].y) === parent?.y),
        );
        const edge2 = layout.edges.find(
            (e) =>
                (Math.floor(e.points[0].y) === child2?.y &&
                    Math.floor(e.points[e.points.length - 1].y) === parent?.y) ||
                (Math.floor(e.points[e.points.length - 1].y) === child2?.y && Math.floor(e.points[0].y) === parent?.y),
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

        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
        const layout = computeGraphLayout(logs);

        const mergeNode = layout.nodes.find((n) => logs[n.y].description.includes('MergeChild'));
        const p1Node = layout.nodes.find((n) => logs[n.y].description.includes('P1'));
        const p2Node = layout.nodes.find((n) => logs[n.y].description.includes('P2'));

        expect(mergeNode).toBeDefined();
        expect(p1Node).toBeDefined();
        expect(p2Node).toBeDefined();

        // Merge should connect to P1 and P2
        const e1 = layout.edges.find(
            (e) =>
                Math.floor(e.points[0].y) === mergeNode?.y && Math.floor(e.points[e.points.length - 1].y) === p1Node?.y,
        );
        const e2 = layout.edges.find(
            (e) =>
                Math.floor(e.points[0].y) === mergeNode?.y && Math.floor(e.points[e.points.length - 1].y) === p2Node?.y,
        );

        expect(e1).toBeDefined();
        expect(e2).toBeDefined();

        // P1 and P2 should be in different lanes
        if (p1Node?.y === p2Node?.y) {
            expect(p1Node?.x).not.toBe(p2Node?.x);
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
            { label: 'head', description: 'tqlynzyq', parents: ['vpm'], isCurrentWorkingCopy: true },
        ]);

        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
        const layout = computeGraphLayout(logs);

        // NOTE: We need to manually calculate headId because renderToAscii relied on it being in scope/verified.
        // The logs array has change_id, we can find the one with is_current_working_copy.
        const headLog = logs.find((l) => l.is_current_working_copy);
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
        expect(cool?.y).toBeLessThan(initial?.y as number);
        expect(fakeTSNode?.y).toBeLessThan(initial?.y as number);

        // Ensure different lanes
        expect(cool?.x).not.toBe(fakeTSNode?.x);

        // CC (Child of Fake TS)
        const cc = layout.nodes.find((n) => logs[n.y].description.includes('cc file'));
        expect(cc).toBeDefined();
        // CC should be above Fake TS
        expect(cc?.y).toBeLessThan(fakeTSNode?.y as number);
        // CC should be in same lane as Fake TS (standard behavior)
        expect(cc?.x).toBe(fakeTSNode?.x);

        // Orcs (Child of Cool)
        const orcs = layout.nodes.find((n) => logs[n.y].description.includes('Orcs'));
        expect(orcs).toBeDefined();

        // vpmososp (Child of Cool)
        const vpm = layout.nodes.find((n) => logs[n.y].description.includes('vpmososp'));
        expect(vpm).toBeDefined();

        // Verify Fork at Cool
        expect(orcs?.y).toBeLessThan(cool?.y as number);
        expect(vpm?.y).toBeLessThan(cool?.y as number);
        expect(orcs?.x).not.toBe(vpm?.x);
    });

    test('Even More Complex Replay', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'Base', parents: ['root()'] },
            { label: 'main', description: 'Main', parents: ['base'] },
            { label: 'side', description: 'Side', parents: ['base'] },
            { label: 'merge', description: 'Merge', parents: ['main', 'side'] },
            { label: 'chain', description: 'Chain', parents: ['merge'] },
            { label: 'branch', description: 'Branch', parents: ['main'] },
            { label: 'wc', description: 'WC', parents: ['main'], isCurrentWorkingCopy: true },
        ]);

        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
        const layout = computeGraphLayout(logs);

        const headLog = logs.find((l) => l.is_current_working_copy);
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
            { label: 'uoym', description: 'uoym', parents: ['zonk'], isCurrentWorkingCopy: true },
        ]);

        const jjService = new JjService(repo.path);
        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
        const layout = computeGraphLayout(logs);

        const headLog = logs.find((l) => l.is_current_working_copy);
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
            { label: 'c', description: 'C', parents: ['p'], isCurrentWorkingCopy: true },
        ]);

        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
        const layout = computeGraphLayout(logs);

        const headLog = logs.find((l) => l.is_current_working_copy);
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
            { label: 'wr', description: 'wr', parents: ['ux'], isCurrentWorkingCopy: true },
        ]);

        const layout = computeGraphLayout(await jjService.getLog({ includeNearestVisibleAncestors: true }));
        const headId = layout.nodes[0].changeId;

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, headId).trim();

        expect(generatedOutput).toBe(expectedOutput);
    });

    test('History Elision Marker', async () => {
        // Setup:
        // A -> B -> C
        // if we log {A, C}, the edge from C -> A should be elided.
        await buildGraph(repo, [
            { label: 'a', description: 'A' },
            { label: 'b', description: 'B', parents: ['a'] },
            { label: 'c', description: 'C', parents: ['b'] },
        ]);

        const allLogs = await jjService.getLog({});
        const aLog = allLogs.find((l) => l.description.trim() === 'A');
        const cLog = allLogs.find((l) => l.description.trim() === 'C');

        if (!aLog || !cLog) {
            throw new Error('Logs not found');
        }

        // Manually simulate a gap by passing C and A but not B.
        // We need to ensure C's nearest_visible_ancestors correctly points to A.
        const cEntry = { ...cLog, nearest_visible_ancestors: [aLog.change_id] };
        const logs = [cEntry, aLog];

        const layout = computeGraphLayout(logs);

        const cNode = layout.nodes.find((n) => n.changeId === cLog?.change_id);
        const aNode = layout.nodes.find((n) => n.changeId === aLog?.change_id);

        expect(cNode).toBeDefined();
        expect(aNode).toBeDefined();

        const edge = layout.edges.find(
            (e) => Math.floor(e.points[0].y) === cNode?.y && Math.floor(e.points[e.points.length - 1].y) === aNode?.y,
        );
        expect(edge).toBeDefined();
        expect(edge?.isElided).toBe(true);
    });
});
