/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeGap, computeMaxShortestIdLength, computeGraphAreaWidth } from '../webview/layout-utils';

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
             const commits = [
                { change_id_shortest: 'abc' },
                { change_id_shortest: undefined },
            ];
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
});
