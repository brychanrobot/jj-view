/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';
import {
    combineConflictLines,
    computeThreeWayMerge,
    computeWordDiffLines,
    ignoreConflictSide,
    type MergeCleanSegment,
    type MergeConflictHunk,
    parseConflictMarkersFallback,
    renderMergedContent,
    resolveAllConflicts,
    resolveConflictHunk,
    syncMergeDocumentFromResultText,
    toggleAutoMergedSegment,
    toggleConflictHandled,
} from '../src/merge/three-way-merge';

describe('three-way-merge', () => {
    test('automatically merges non-overlapping Left and Right changes', () => {
        const base = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', ''].join('\n');
        const left = ['line 1 (left edit)', 'line 2', 'line 3', 'line 4', 'line 5', ''].join('\n');
        const right = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5 (right edit)', ''].join('\n');

        const doc = computeThreeWayMerge(base, left, right);
        const conflicts = doc.segments.filter((s) => s.type === 'conflict');
        expect(conflicts).toHaveLength(0);

        const autoLeft = doc.segments.filter((s) => s.type === 'clean' && s.origin === 'left');
        const autoRight = doc.segments.filter((s) => s.type === 'clean' && s.origin === 'right');
        expect(autoLeft).toHaveLength(1);
        expect(autoRight).toHaveLength(1);

        expect(renderMergedContent(doc)).toBe(
            ['line 1 (left edit)', 'line 2', 'line 3', 'line 4', 'line 5 (right edit)', ''].join('\n'),
        );
    });

    test('automatically merges adjacent non-overlapping line modifications', () => {
        const base = 'alpha\nbeta\ngamma\n';
        const left = 'alpha-left\nbeta\ngamma\n';
        const right = 'alpha\nbeta-right\ngamma\n';

        const doc = computeThreeWayMerge(base, left, right);
        const conflicts = doc.segments.filter((s) => s.type === 'conflict');
        expect(conflicts).toHaveLength(0);
        expect(renderMergedContent(doc)).toBe('alpha-left\nbeta-right\ngamma\n');
    });

    test('automatically merges identical changes made on both sides (false conflict)', () => {
        const base = 'header\nold value\nfooter\n';
        const left = 'header\nsame new value\nfooter\n';
        const right = 'header\nsame new value\nfooter\n';

        const doc = computeThreeWayMerge(base, left, right);
        const conflicts = doc.segments.filter((s) => s.type === 'conflict');
        expect(conflicts).toHaveLength(0);

        const bothIdentical = doc.segments.filter((s) => s.type === 'clean' && s.origin === 'both-identical');
        expect(bothIdentical).toHaveLength(1);
        expect(renderMergedContent(doc)).toBe('header\nsame new value\nfooter\n');
    });

    test('identifies true conflict hunks while auto-merging surrounding non-conflicting changes', () => {
        const base = [
            'import { a } from "./a";',
            'const config = {',
            '  timeout: 1000,',
            '  retries: 3,',
            '};',
            'export default config;',
            '',
        ].join('\n');

        const left = [
            'import { a } from "./a";',
            'import { leftHelper } from "./left";',
            'const config = {',
            '  timeout: 2500,',
            '  retries: 3,',
            '};',
            'export default config;',
            '',
        ].join('\n');

        const right = [
            'import { a } from "./a";',
            'const config = {',
            '  timeout: 5000,',
            '  retries: 3,',
            '};',
            'export const extraRight = true;',
            'export default config;',
            '',
        ].join('\n');

        const doc = computeThreeWayMerge(base, left, right);
        const conflicts = doc.segments.filter((s): s is MergeConflictHunk => s.type === 'conflict');
        expect(conflicts).toHaveLength(1);

        const hunk = conflicts[0];
        expect(hunk.baseLines).toEqual(['  timeout: 1000,']);
        expect(hunk.leftLines).toEqual(['  timeout: 2500,']);
        expect(hunk.rightLines).toEqual(['  timeout: 5000,']);
        expect(hunk.resolution).toBe('unhandled');
        expect(hunk.handled).toBe(false);
        expect(hunk.isOrderRelevant).toBe(true);

        // Auto-merged imports and exports are already present in rendered output;
        // accepting Left on the conflict resolves the entire file cleanly.
        const resolvedLeft = resolveConflictHunk(doc, hunk.id, 'left');
        expect(renderMergedContent(resolvedLeft)).toBe(
            [
                'import { a } from "./a";',
                'import { leftHelper } from "./left";',
                'const config = {',
                '  timeout: 2500,',
                '  retries: 3,',
                '};',
                'export const extraRight = true;',
                'export default config;',
                '',
            ].join('\n'),
        );

        // Accepting Right on the conflict
        const resolvedRight = resolveConflictHunk(doc, hunk.id, 'right');
        expect(renderMergedContent(resolvedRight)).toBe(
            [
                'import { a } from "./a";',
                'import { leftHelper } from "./left";',
                'const config = {',
                '  timeout: 5000,',
                '  retries: 3,',
                '};',
                'export const extraRight = true;',
                'export default config;',
                '',
            ].join('\n'),
        );

        // Accepting Both (Left First)
        const resolvedBothLR = resolveConflictHunk(doc, hunk.id, 'both-left-first');
        expect(renderMergedContent(resolvedBothLR)).toBe(
            [
                'import { a } from "./a";',
                'import { leftHelper } from "./left";',
                'const config = {',
                '  timeout: 2500,',
                '  timeout: 5000,',
                '  retries: 3,',
                '};',
                'export const extraRight = true;',
                'export default config;',
                '',
            ].join('\n'),
        );

        // Accepting Both (Right First)
        const resolvedBothRL = resolveConflictHunk(doc, hunk.id, 'both-right-first');
        expect(renderMergedContent(resolvedBothRL)).toBe(
            [
                'import { a } from "./a";',
                'import { leftHelper } from "./left";',
                'const config = {',
                '  timeout: 5000,',
                '  timeout: 2500,',
                '  retries: 3,',
                '};',
                'export const extraRight = true;',
                'export default config;',
                '',
            ].join('\n'),
        );

        // Custom edit on the conflict hunk
        const resolvedCustom = resolveConflictHunk(doc, hunk.id, 'custom', ['  timeout: 3500,']);
        expect(renderMergedContent(resolvedCustom)).toBe(
            [
                'import { a } from "./a";',
                'import { leftHelper } from "./left";',
                'const config = {',
                '  timeout: 3500,',
                '  retries: 3,',
                '};',
                'export const extraRight = true;',
                'export default config;',
                '',
            ].join('\n'),
        );
    });

    test('smartCombineInputs merges non-overlapping token edits on the same line (VS Code parity)', () => {
        const base = 'function connect(host = "localhost", port = 8080) {\n  return true;\n}\n';
        const left = 'function connect(host = "0.0.0.0", port = 8080) {\n  return true;\n}\n';
        const right = 'function connect(host = "localhost", port = 9090) {\n  return true;\n}\n';

        const doc = computeThreeWayMerge(base, left, right);
        const conflicts = doc.segments.filter((s): s is MergeConflictHunk => s.type === 'conflict');
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].isOrderRelevant).toBe(false);

        const combined = resolveConflictHunk(doc, conflicts[0].id, 'both-left-first');
        expect(renderMergedContent(combined)).toBe(
            'function connect(host = "0.0.0.0", port = 9090) {\n  return true;\n}\n',
        );
    });

    test('computeWordDiffLines highlights only modified tokens relative to Base', () => {
        const diff = computeWordDiffLines(['  timeout: 1000,'], ['  timeout: 2500,']);
        expect(diff).toHaveLength(1);
        expect(diff[0].tokens).toEqual([
            { text: '  timeout: ', changed: false },
            { text: '2500', changed: true },
            { text: ',', changed: false },
        ]);
    });

    function getFirstConflict(doc: ReturnType<typeof computeThreeWayMerge>): MergeConflictHunk {
        const found = doc.segments.find((s): s is MergeConflictHunk => s.type === 'conflict');
        if (!found) {
            throw new Error('Expected conflict hunk');
        }
        return found;
    }

    test('ignoreConflictSide and toggleConflictHandled allow keeping Base while marking conflict handled', () => {
        const base = 'a\nmode: "default"\nb\n';
        const left = 'a\nmode: "left"\nb\n';
        const right = 'a\nmode: "right"\nb\n';

        let doc = computeThreeWayMerge(base, left, right);
        const hunkId = getFirstConflict(doc).id;

        // Ignore Left only -> Left is handled, Right still unhandled
        doc = ignoreConflictSide(doc, hunkId, 'left');
        let hunk = getFirstConflict(doc);
        expect(hunk.leftHandled).toBe(true);
        expect(hunk.rightHandled).toBe(false);
        expect(hunk.handled).toBe(false);

        // Ignore Right as well -> both sides handled, resolution is 'base', output keeps base line
        doc = ignoreConflictSide(doc, hunkId, 'right');
        hunk = getFirstConflict(doc);
        expect(hunk.handled).toBe(true);
        expect(hunk.resolution).toBe('base');
        expect(renderMergedContent(doc)).toBe('a\nmode: "default"\nb\n');

        // Toggle handled off and back on via toggleConflictHandled
        doc = toggleConflictHandled(doc, hunkId);
        hunk = getFirstConflict(doc);
        expect(hunk.handled).toBe(false);
        expect(hunk.resolution).toBe('unhandled');

        doc = toggleConflictHandled(doc, hunkId);
        hunk = getFirstConflict(doc);
        expect(hunk.handled).toBe(true);
        expect(hunk.resolution).toBe('base');
    });

    test('toggleAutoMergedSegment can revert and re-apply non-conflicting auto-merged changes', () => {
        const base = 'line 1\nline 2\n';
        const left = 'line 1 (auto)\nline 2\n';
        const right = 'line 1\nline 2\n';

        let doc = computeThreeWayMerge(base, left, right);
        const autoSeg = doc.segments.find((s): s is MergeCleanSegment => s.type === 'clean' && s.origin === 'left');
        if (!autoSeg) {
            throw new Error('Expected auto-merged segment');
        }
        expect(autoSeg.accepted).toBe(true);
        expect(renderMergedContent(doc)).toBe('line 1 (auto)\nline 2\n');

        doc = toggleAutoMergedSegment(doc, autoSeg.id);
        expect(renderMergedContent(doc)).toBe('line 1\nline 2\n');

        doc = toggleAutoMergedSegment(doc, autoSeg.id);
        expect(renderMergedContent(doc)).toBe('line 1 (auto)\nline 2\n');
    });

    test('syncMergeDocumentFromResultText bidirectionally infers conflict state and preserves clean edits', () => {
        const base = 'header\nvalue = 0\nfooter\n';
        const left = 'header\nvalue = 1\nfooter\n';
        const right = 'header\nvalue = 2\nfooter\n';

        let doc = computeThreeWayMerge(base, left, right);

        // User edits the conflict line in the Result editor to match Right ('value = 2')
        doc = syncMergeDocumentFromResultText(doc, 'header\nvalue = 2\nfooter\n');
        let hunk = getFirstConflict(doc);
        expect(hunk.resolution).toBe('right');
        expect(hunk.handled).toBe(true);

        // User edits the conflict line to a custom manual resolution AND edits 'header' to 'custom header'
        doc = syncMergeDocumentFromResultText(doc, 'custom header\nvalue = 42\nfooter\n');
        hunk = getFirstConflict(doc);
        expect(hunk.resolution).toBe('custom');
        expect(hunk.handled).toBe(true);
        expect(hunk.resolvedLines).toEqual(['value = 42']);
        expect(renderMergedContent(doc)).toBe('custom header\nvalue = 42\nfooter\n');

        // Clicking Accept Left on the hunk preserves the 'custom header' edit in the clean segment!
        doc = resolveConflictHunk(doc, hunk.id, 'left');
        expect(renderMergedContent(doc)).toBe('custom header\nvalue = 1\nfooter\n');
    });

    test('combineConflictLines deduplicates shared prefix and suffix lines', () => {
        const left = ['// section', 'const a = 1;', '// end'];
        const right = ['// section', 'const b = 2;', '// end'];

        expect(combineConflictLines(left, right)).toEqual(['// section', 'const a = 1;', 'const b = 2;', '// end']);
        expect(combineConflictLines(right, left)).toEqual(['// section', 'const b = 2;', 'const a = 1;', '// end']);
    });

    test('resolveAllConflicts resolves all or only unhandled conflicts', () => {
        const base = 'a\nb\nc\n';
        const left = 'a-left\nb\nc-left\n';
        const right = 'a-right\nb\nc-right\n';

        const doc = computeThreeWayMerge(base, left, right);
        const conflicts = doc.segments.filter((s): s is MergeConflictHunk => s.type === 'conflict');
        expect(conflicts).toHaveLength(2);

        const partial = resolveConflictHunk(doc, conflicts[0].id, 'left');
        const restRight = resolveAllConflicts(partial, 'right', true);
        expect(renderMergedContent(restRight)).toBe('a-left\nb\nc-right\n');

        const allRight = resolveAllConflicts(partial, 'right', false);
        expect(renderMergedContent(allRight)).toBe('a-right\nb\nc-right\n');
    });

    test('parseConflictMarkersFallback parses both JJ diff style and Git diff3 style conflict markers', () => {
        const jjConflict = [
            'top line',
            '<<<<<<< conflict 1 of 1',
            '%%%%%%% diff from: abcdef "base"',
            '\\\\\\\\\\\\\\        to: 123456 "side 1"',
            '-base middle',
            '+left middle',
            '+++++++ 789abc "side 2"',
            'right middle',
            '>>>>>>> conflict 1 of 1 ends',
            'bottom line',
            '',
        ].join('\n');

        const parsedJj = parseConflictMarkersFallback(jjConflict);
        expect(parsedJj).toEqual({
            base: 'top line\nbase middle\nbottom line\n',
            left: 'top line\nleft middle\nbottom line\n',
            right: 'top line\nright middle\nbottom line\n',
        });

        const gitConflict = [
            'top line',
            '<<<<<<< Side 1',
            'left middle',
            '||||||| Base',
            'base middle',
            '=======',
            'right middle',
            '>>>>>>> Side 2',
            'bottom line',
            '',
        ].join('\n');

        const parsedGit = parseConflictMarkersFallback(gitConflict);
        expect(parsedGit).toEqual({
            base: 'top line\nbase middle\nbottom line\n',
            left: 'top line\nleft middle\nbottom line\n',
            right: 'top line\nright middle\nbottom line\n',
        });
    });
});
