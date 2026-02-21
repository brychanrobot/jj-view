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
        it('should return 8 for empty commit list', () => {
            expect(computeMaxShortestIdLength([])).toBe(8);
        });

        it('should return 8 if no shortest IDs are present', () => {
            const commits = [{ change_id_shortest: undefined }, {}];
            expect(computeMaxShortestIdLength(commits)).toBe(8);
        });

        it('should return the maximum length of shortest IDs', () => {
            const commits = [
                { change_id_shortest: 'abc' },
                { change_id_shortest: 'abcde' },
                { change_id_shortest: 'ab' },
            ];
            expect(computeMaxShortestIdLength(commits)).toBe(5);
        });

        it('should ignore undefined shortest IDs', () => {
             const commits = [
                { change_id_shortest: 'abc' },
                { change_id_shortest: undefined },
            ];
            expect(computeMaxShortestIdLength(commits)).toBe(3);
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
