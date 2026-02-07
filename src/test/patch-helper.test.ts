/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PatchHelper, SelectionRange } from '../patch-helper';

// Helper to create range
const range = (start: number, end: number): SelectionRange => ({ startLine: start, endLine: end });

describe('PatchHelper', () => {
    describe('parseDiff', () => {
        it('should parse a simple diff with one chunk', () => {
            const diff = `diff --git a/file b/file
index 1..2 100644
--- a/file
+++ b/file
@@ -1,2 +1,3 @@
 line1
-line2
+line2 modified
+line3 added`;
            const chunks = PatchHelper.parseDiff(diff);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].oldStart).toBe(1);
            expect(chunks[0].oldLines).toBe(2);
            expect(chunks[0].newStart).toBe(1);
            expect(chunks[0].newLines).toBe(3);
            expect(chunks[0].changes).toHaveLength(4);
            expect(chunks[0].changes[0].content).toBe(' line1');
            expect(chunks[0].changes[1].content).toBe('-line2');
        });

        it('should parse multiple chunks', () => {
            const diff = `@@ -1,1 +1,1 @@
 context
@@ -10,1 +10,2 @@
-old
+new1
+new2`;
            const chunks = PatchHelper.parseDiff(diff);
            expect(chunks).toHaveLength(2);
            expect(chunks[0].changes).toHaveLength(1);
            expect(chunks[1].changes).toHaveLength(3);
        });
    });

    describe('applySelectedLines', () => {
        // Base content for tests
        const baseContent = `line1
line2
line3
line4`;

        it('should apply a selected addition (Move to Parent)', () => {
            const diff = `--- a/file
+++ b/file
@@ -2,1 +2,1 @@
-line2
+line2mod`;

            // Selection covers line 2 (0-indexed line 1)
            const selections = [range(1, 1)];

            const result = PatchHelper.applySelectedLines(baseContent, diff, selections);

            expect(result).toBe(`line1
line2mod
line3
line4`);
        });

        it('should ignore unselected lines', () => {
            const diff = `--- a/file
+++ b/file
@@ -1,1 +1,1 @@
-line1
+line1mod
@@ -4,1 +4,1 @@
-line4
+line4mod`;

            // Select line 4 (index 3).
            const selections = [range(3, 3)];

            const result = PatchHelper.applySelectedLines(baseContent, diff, selections);

            expect(result).toBe(`line1
line2
line3
line4mod`);
        });

        it('should handle partial application (selecting only one added line)', () => {
            const diff = `--- a/file
+++ b/file
@@ -2,1 +2,3 @@
 line2
+line2a
+line2b`;

            // user selects ONLY line2b (index 3)
            const selections = [range(3, 3)];

            const result = PatchHelper.applySelectedLines(baseContent, diff, selections);

            expect(result).toBe(`line1
line2
line2b
line3
line4`);
        });

        it('should apply deletion if intersecting selection', () => {
            const diff = `--- a/file
+++ b/file
@@ -2,3 +2,2 @@
 line2
-line3
 line4`;

            // Selection (idx 2) corresponds to line4 in new file.
            const selections = [range(2, 2)];

            const result = PatchHelper.applySelectedLines(baseContent, diff, selections);

            expect(result).toBe(`line1
line2
line4`);
        });

        it('should NOT apply deletion if line not selected', () => {
            const diff = `--- a/file
+++ b/file
@@ -2,3 +2,2 @@
 line2
-line3
 line4`;

            // User selects line 10.
            const selections = [range(10, 10)];

            const result = PatchHelper.applySelectedLines(baseContent, diff, selections);

            // Should keep line3
            expect(result).toBe(`line1
line2
line3
line4`);
        });

        it('should handle the complex movePartialToChild scenario', () => {
            // Replicates the scenario from jj-service.test.ts failure
            const base = 'A\nB\nB2\nB3\nB4\nC\n';
            const diff = `--- a/file
+++ b/file
@@ -1,6 +1,3 @@
-A
+ModA
 B
-B2
-B3
-B4
-C
+ModC`;

            // Select ONLY ModC (Line 3 in New File -> Index 2)
            const selections = [range(2, 2)];

            // With shared-index model, selecting ModC at the same position as B2, B3, B4
            // will select the entire replacement block. So A is kept, B is context,
            // and the block [B2,B3,B4,C -> ModC] is applied.
            const result = PatchHelper.applySelectedLines(base, diff, selections);

            expect(result).toBe('A\nB\nModC\n');
        });
    });
});
