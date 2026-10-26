/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';
import { mapLineAcrossHunks, parseDiffHunks, parseMultiFileDiffHunks } from '../utils/line-drift';

describe('line-drift utilities', () => {
    test('parseDiffHunks extracts -U0 unified diff hunk headers', () => {
        const diff = [
            'diff --git a/file.ts b/file.ts',
            'index 1111111..2222222 100644',
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -0,0 +1,3 @@',
            '+line 1',
            '+line 2',
            '+line 3',
            '@@ -10 +13,2 @@ function foo()',
            '-old 10',
            '+new 13',
            '+new 14',
            '@@ -20,2 +23,0 @@',
            '-del 20',
            '-del 21',
        ].join('\n');

        expect(parseDiffHunks(diff)).toEqual([
            { oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 },
            { oldStart: 10, oldCount: 1, newStart: 13, newCount: 2 },
            { oldStart: 20, oldCount: 2, newStart: 23, newCount: 0 },
        ]);
    });

    test('parseMultiFileDiffHunks groups hunks by destination file path', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -5,0 +6,2 @@',
            '+added 1',
            '+added 2',
            'diff --git a/src/b.ts b/src/b.ts',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1,3 +1,1 @@',
            '-a',
            '-b',
            '-c',
            '+d',
        ].join('\n');

        const map = parseMultiFileDiffHunks(diff);
        expect(map.get('src/a.ts')).toEqual([{ oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 }]);
        expect(map.get('src/b.ts')).toEqual([{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 1 }]);
    });

    test('mapLineAcrossHunks shifts lines after insertions and deletions', () => {
        const hunks = [
            // Insert 3 lines at top of file (after line 0)
            { oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 },
            // Replace 1 line at old line 10 with 2 lines at new line 13..14 (+1 net)
            { oldStart: 10, oldCount: 1, newStart: 13, newCount: 2 },
            // Delete 2 lines at old lines 20..21 (-2 net)
            { oldStart: 20, oldCount: 2, newStart: 23, newCount: 0 },
        ];

        // Non-positive lines remain unchanged
        expect(mapLineAcrossHunks(0, hunks)).toBe(0);

        // Old line 1 shifted by +3 from top insertion -> 4
        expect(mapLineAcrossHunks(1, hunks)).toBe(4);

        // Old line 9 shifted by +3 -> 12
        expect(mapLineAcrossHunks(9, hunks)).toBe(12);

        // Old line 10 is inside the modified hunk -> clamps to newStart (13)
        expect(mapLineAcrossHunks(10, hunks)).toBe(13);

        // Old line 15 is after first two hunks (+3 + 1 = +4) -> 19
        expect(mapLineAcrossHunks(15, hunks)).toBe(19);

        // Old line 20 is deleted in third hunk -> clamps to newStart (23)
        expect(mapLineAcrossHunks(20, hunks)).toBe(23);
        expect(mapLineAcrossHunks(21, hunks)).toBe(23);

        // Old line 25 is after all three hunks (+3 + 1 - 2 = +2) -> 27
        expect(mapLineAcrossHunks(25, hunks)).toBe(27);
    });
});
