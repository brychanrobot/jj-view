/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { JjLogEntry } from '../jj-types';
import type { GraphLayout } from '../webview/graph-model';
import {
    computeCompactRowMaxX,
    computeGap,
    computeGraphAreaWidth,
    computeMaxShortestIdLength,
} from '../webview/layout-utils';
import { createMock } from './test-utils';

describe('Layout Utils', () => {
    describe('computeGap', () => {
        it('should return half of the font size rounded', () => {
            expect(computeGap(10)).toBe(5);
            expect(computeGap(13)).toBe(7);
            expect(computeGap(16)).toBe(8);
        });
    });

    describe('computeMaxShortestIdLength', () => {
        it('should return minLen for empty commit list', () => {
            expect(computeMaxShortestIdLength([], 8)).toBe(8);
            expect(computeMaxShortestIdLength([], 1)).toBe(1);
        });

        it('should return minLen if no shortest IDs are present', () => {
            const commits = [{ change_id_shortest: undefined }, {}];
            expect(computeMaxShortestIdLength(commits, 8)).toBe(8);
            expect(computeMaxShortestIdLength(commits, 12)).toBe(12);
        });

        it('should return the maximum length of shortest IDs if greater than minLen', () => {
            const commits = [
                { change_id_shortest: 'abc' },
                { change_id_shortest: 'abcde' },
                { change_id_shortest: 'ab' },
            ];
            expect(computeMaxShortestIdLength(commits, 1)).toBe(5);
            expect(computeMaxShortestIdLength(commits, 8)).toBe(8);
        });

        it('should ignore undefined shortest IDs', () => {
            const commits = [{ change_id_shortest: 'abc' }, { change_id_shortest: undefined }];
            expect(computeMaxShortestIdLength(commits, 1)).toBe(3);
        });
    });

    describe('computeGraphAreaWidth', () => {
        it('should calculate correct width', () => {
            // graphWidth * laneWidth + leftMargin + gap
            // 2 * 16 + 12 + 10 = 32 + 12 + 10 = 54
            expect(computeGraphAreaWidth(2, 16, 12, 10)).toBe(54);
        });
    });

    describe('computeCompactRowMaxX', () => {
        it('should account for node positions', () => {
            const layout: GraphLayout = {
                nodes: [{ commitId: 'c1', changeId: 'c1', x: 0, y: 0, color: 'red', isCurrentWorkingCopy: false }],
                edges: [],
                width: 3,
                height: 1,
                rows: [createMock<JjLogEntry>({})],
            };
            const result = computeCompactRowMaxX(layout);
            expect(result).toEqual([0]);
        });

        it('should account for vertical edges passing through rows', () => {
            const layout: GraphLayout = {
                nodes: [{ commitId: 'c1', changeId: 'c1', x: 0, y: 0, color: 'red', isCurrentWorkingCopy: false }],
                edges: [
                    {
                        id: 'e1',
                        points: [
                            { type: 'node', x: 2, y: 0 },
                            { type: 'node', x: 2, y: 1 },
                            { type: 'node', x: 2, y: 2 },
                        ],
                        type: 'parent',
                        color: 'green',
                    },
                ],
                width: 3,
                height: 3,
                rows: [createMock<JjLogEntry>({}), createMock<JjLogEntry>({}), createMock<JjLogEntry>({})],
            };
            const result = computeCompactRowMaxX(layout);
            // Edge at x1=2 for y=0,1. Edge at x2=2 for y=2.
            expect(result).toEqual([2, 2, 2]);
        });

        it('should account for curved segments correctly', () => {
            const layout: GraphLayout = {
                nodes: [{ commitId: 'c1', changeId: 'c1', x: 0, y: 0, color: 'red', isCurrentWorkingCopy: false }],
                edges: [
                    {
                        id: 'e1',
                        points: [
                            { type: 'node', x: 4, y: 0 },
                            { type: 'node', x: 4, y: 1 },
                            { type: 'link', x: 4, y: 1.5 },
                            { type: 'link', x: 0, y: 1.5 },
                            { type: 'node', x: 0, y: 2 },
                        ],
                        type: 'parent',
                        color: 'green',
                    },
                ],
                width: 6,
                height: 3,
                rows: [createMock<JjLogEntry>({}), createMock<JjLogEntry>({}), createMock<JjLogEntry>({})],
            };
            const result = computeCompactRowMaxX(layout);
            // Node at row 0: x=0. Edge at row 0: x=4. max=4.
            // Edge at row 1: x=4. max=4.
            // Edge at row 2: x=0. max=0.
            expect(result).toEqual([4, 4, 0]);
        });

        it('should account for intermediate rows without explicit points', () => {
            const layout: GraphLayout = {
                nodes: [],
                edges: [
                    {
                        id: 'e1',
                        points: [
                            { type: 'node', x: 5, y: 5 },
                            { type: 'link', x: 1, y: 2.5 },
                            { type: 'node', x: 1, y: 2 },
                        ],
                        type: 'parent',
                        color: 'green',
                    },
                ],
                width: 6,
                height: 6,
                rows: Array.from({ length: 6 }, () => createMock<JjLogEntry>({})),
            };
            const result = computeCompactRowMaxX(layout);
            expect(result).toEqual([0, 0, 1, 5, 5, 5]);
        });
    });
});
