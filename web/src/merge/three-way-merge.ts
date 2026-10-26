/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MergeLineRange {
    /** 1-based inclusive start line (or next line number when count === 0). */
    startLine: number;
    /** 1-based inclusive end line (startLine - 1 when count === 0). */
    endLine: number;
}

export type AutoMergeOrigin = 'unchanged' | 'left' | 'right' | 'both-identical';

export type ConflictResolution =
    | 'unhandled'
    | 'left'
    | 'right'
    | 'both-left-first'
    | 'both-right-first'
    | 'base'
    | 'custom';

export interface WordDiffToken {
    text: string;
    changed: boolean;
}

export interface WordDiffLine {
    tokens: WordDiffToken[];
}

export interface MergeCleanSegment {
    type: 'clean';
    id: string;
    origin: AutoMergeOrigin;
    accepted: boolean;
    baseRange: MergeLineRange;
    leftRange: MergeLineRange;
    rightRange: MergeLineRange;
    resultRange: MergeLineRange;
    baseLines: string[];
    leftLines: string[];
    rightLines: string[];
    leftWordDiff: WordDiffLine[];
    rightWordDiff: WordDiffLine[];
    lines: string[];
}

export interface MergeConflictHunk {
    type: 'conflict';
    id: string;
    index: number;
    baseRange: MergeLineRange;
    leftRange: MergeLineRange;
    rightRange: MergeLineRange;
    resultRange: MergeLineRange;
    baseLines: string[];
    leftLines: string[];
    rightLines: string[];
    leftWordDiff: WordDiffLine[];
    rightWordDiff: WordDiffLine[];
    resolution: ConflictResolution;
    leftHandled: boolean;
    rightHandled: boolean;
    handled: boolean;
    isOrderRelevant: boolean;
    resolvedLines: string[];
}

export type MergeSegment = MergeCleanSegment | MergeConflictHunk;

export interface ThreeWayMergeDocument {
    segments: MergeSegment[];
    eol: '\n' | '\r\n';
    hasTrailingNewline: boolean;
}

interface SplitLinesResult {
    lines: string[];
    eol: '\n' | '\r\n';
    hasTrailingNewline: boolean;
}

export interface SequenceEdit<T> {
    baseStart: number;
    baseEnd: number;
    sideStart: number;
    sideEnd: number;
    sideItems: T[];
}

export interface BaseEdit {
    baseStart: number;
    baseEnd: number;
    sideStart: number;
    sideEnd: number;
    sideLines: string[];
}

interface MyersTrace {
    trace: Int32Array[];
    foundD: number;
    offset: number;
}

interface ConflictClusterState {
    clusterBaseStart: number;
    clusterBaseEnd: number;
    li: number;
    ri: number;
    lastL: BaseEdit | undefined;
    lastR: BaseEdit | undefined;
    clusterHasEmptyEditAtEnd: boolean;
}

export function splitTextLines(text: string): SplitLinesResult {
    if (text.length === 0) {
        return { lines: [], eol: '\n', hasTrailingNewline: false };
    }
    const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
    const hasTrailingNewline = text.endsWith('\n');
    const normalized = eol === '\r\n' ? text.replace(/\r\n/g, '\n') : text;
    const rawParts = normalized.split('\n');
    if (hasTrailingNewline) {
        rawParts.pop();
    }
    return { lines: rawParts, eol, hasTrailingNewline };
}

export function joinTextLines(lines: readonly string[], eol: '\n' | '\r\n', hasTrailingNewline: boolean): string {
    if (lines.length === 0) {
        return '';
    }
    const body = lines.join(eol);
    return hasTrailingNewline ? `${body}${eol}` : body;
}

function makeLineRange(start0: number, end0: number): MergeLineRange {
    return {
        startLine: start0 + 1,
        endLine: end0,
    };
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((item, index) => item === b[index]);
}

function countCommonPrefix<T>(a: readonly T[], b: readonly T[]): number {
    const minLen = Math.min(a.length, b.length);
    let prefixLen = 0;
    while (prefixLen < minLen && a[prefixLen] === b[prefixLen]) {
        prefixLen++;
    }
    return prefixLen;
}

function countCommonSuffix<T>(a: readonly T[], b: readonly T[], prefixLen: number): number {
    const maxSuffix = Math.min(a.length, b.length) - prefixLen;
    let suffixLen = 0;
    while (suffixLen < maxSuffix && a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]) {
        suffixLen++;
    }
    return suffixLen;
}

function chooseStartXForDiagonal(v: Int32Array, offset: number, k: number, d: number): number {
    const kIdx = offset + k;
    const moveDown = k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1]);
    return moveDown ? v[kIdx + 1] : v[kIdx - 1] + 1;
}

function choosePrevDiagonal(vPrev: Int32Array, offset: number, k: number, d: number): number {
    const kIdx = offset + k;
    const cameFromAbove = k === -d || (k !== d && vPrev[kIdx - 1] < vPrev[kIdx + 1]);
    return cameFromAbove ? k + 1 : k - 1;
}

function advanceAlongSnake<T>(a: readonly T[], b: readonly T[], startX: number, startY: number): [number, number] {
    let x = startX;
    let y = startY;
    while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
    }
    return [x, y];
}

function stepMyersDepth<T>(a: readonly T[], b: readonly T[], v: Int32Array, offset: number, d: number): boolean {
    for (let k = -d; k <= d; k += 2) {
        const startX = chooseStartXForDiagonal(v, offset, k, d);
        const startY = startX - k;
        const [endX, endY] = advanceAlongSnake(a, b, startX, startY);
        v[offset + k] = endX;
        if (endX >= a.length && endY >= b.length) {
            return true;
        }
    }
    return false;
}

function findMyersEditTrace<T>(a: readonly T[], b: readonly T[]): MyersTrace {
    const maxD = a.length + b.length;
    const offset = maxD;
    const v = new Int32Array(2 * maxD + 1);
    v.fill(-1);
    v[offset + 1] = 0;
    const trace: Int32Array[] = [];

    for (let d = 0; d <= maxD; d++) {
        trace.push(v.slice());
        if (stepMyersDepth(a, b, v, offset, d)) {
            return { trace, foundD: d, offset };
        }
    }

    return { trace, foundD: maxD, offset };
}

function recordReverseSnake(
    pairs: [number, number][],
    prefixLen: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
): void {
    let x = fromX;
    let y = fromY;
    while (x > toX && y > toY) {
        x--;
        y--;
        pairs.push([prefixLen + x, prefixLen + y]);
    }
}

function backtrackMyersMatches(myers: MyersTrace, midN: number, midM: number, prefixLen: number): [number, number][] {
    const midPairs: [number, number][] = [];
    let x = midN;
    let y = midM;

    for (let d = myers.foundD; d > 0; d--) {
        const vPrev = myers.trace[d];
        const prevK = choosePrevDiagonal(vPrev, myers.offset, x - y, d);
        const prevX = vPrev[myers.offset + prevK];
        const prevY = prevX - prevK;
        recordReverseSnake(midPairs, prefixLen, x, y, prevX, prevY);
        x = prevX;
        y = prevY;
    }

    recordReverseSnake(midPairs, prefixLen, x, y, 0, 0);
    midPairs.reverse();
    return midPairs;
}

/**
 * Myers O((N+M)D) shortest edit script matching algorithm returning matched
 * index pairs `(baseIdx, sideIdx)` in strictly increasing order.
 */
function computeMatchedPairs<T>(baseItems: readonly T[], sideItems: readonly T[]): [number, number][] {
    const n = baseItems.length;
    const m = sideItems.length;
    if (n === 0 || m === 0) {
        return [];
    }

    const prefixLen = countCommonPrefix(baseItems, sideItems);
    const suffixLen = countCommonSuffix(baseItems, sideItems, prefixLen);

    const prefixPairs: [number, number][] = Array.from({ length: prefixLen }, (_, i) => [i, i]);
    const suffixPairs: [number, number][] = Array.from({ length: suffixLen }, (_, idx) => {
        const offsetFromEnd = suffixLen - 1 - idx;
        return [n - 1 - offsetFromEnd, m - 1 - offsetFromEnd];
    });

    const midN = n - prefixLen - suffixLen;
    const midM = m - prefixLen - suffixLen;
    if (midN === 0 || midM === 0) {
        return [...prefixPairs, ...suffixPairs];
    }

    const a = baseItems.slice(prefixLen, n - suffixLen);
    const b = sideItems.slice(prefixLen, m - suffixLen);
    const myers = findMyersEditTrace(a, b);
    const midPairs = backtrackMyersMatches(myers, midN, midM, prefixLen);

    return [...prefixPairs, ...midPairs, ...suffixPairs];
}

function computeSequenceEdits<T>(baseItems: readonly T[], sideItems: readonly T[]): SequenceEdit<T>[] {
    const matches = computeMatchedPairs(baseItems, sideItems);
    const edits: SequenceEdit<T>[] = [];

    let prevBase = -1;
    let prevSide = -1;

    const allAnchors: [number, number][] = [...matches, [baseItems.length, sideItems.length]];
    for (const [currBase, currSide] of allAnchors) {
        const baseStart = prevBase + 1;
        const baseEnd = currBase;
        const sideStart = prevSide + 1;
        const sideEnd = currSide;
        prevBase = currBase;
        prevSide = currSide;

        if (baseStart === baseEnd && sideStart === sideEnd) {
            continue;
        }

        edits.push({
            baseStart,
            baseEnd,
            sideStart,
            sideEnd,
            sideItems: sideItems.slice(sideStart, sideEnd),
        });
    }

    return edits;
}

/**
 * Computes ordered non-overlapping edits transforming `baseLines` into `sideLines`.
 */
export function computeLineEdits(baseLines: readonly string[], sideLines: readonly string[]): BaseEdit[] {
    return computeSequenceEdits(baseLines, sideLines).map((edit) => ({
        baseStart: edit.baseStart,
        baseEnd: edit.baseEnd,
        sideStart: edit.sideStart,
        sideEnd: edit.sideEnd,
        sideLines: edit.sideItems,
    }));
}

const WORD_TOKEN_REGEX = /\n|[A-Za-z0-9_]+|[ \t]+|[^\sA-Za-z0-9_]/g;

function tokenizeForWordDiff(text: string): string[] {
    if (text.length === 0) {
        return [];
    }
    return text.match(WORD_TOKEN_REGEX) ?? [text];
}

function mergeAdjacentWordTokens(tokens: readonly WordDiffToken[]): WordDiffToken[] {
    const merged: WordDiffToken[] = [];
    for (const token of tokens) {
        if (token.text.length === 0) {
            continue;
        }
        const prev = merged[merged.length - 1];
        if (prev && prev.changed === token.changed) {
            prev.text += token.text;
            continue;
        }
        merged.push({ text: token.text, changed: token.changed });
    }
    return merged;
}

function splitTokensIntoLines(tokens: readonly WordDiffToken[], lineCount: number): WordDiffLine[] {
    if (lineCount === 0) {
        return [];
    }
    const lines: WordDiffToken[][] = [[]];
    for (const token of tokens) {
        if (token.text === '\n') {
            lines.push([]);
            continue;
        }
        const parts = token.text.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (i > 0) {
                lines.push([]);
            }
            if (parts[i].length > 0) {
                lines[lines.length - 1].push({ text: parts[i], changed: token.changed });
            }
        }
    }
    while (lines.length < lineCount) {
        lines.push([]);
    }
    return lines.slice(0, lineCount).map((lineTokens) => ({
        tokens: mergeAdjacentWordTokens(lineTokens),
    }));
}

/**
 * Computes word-level diff tokens for each line in `sideLines` relative to `baseLines`.
 */
export function computeWordDiffLines(baseLines: readonly string[], sideLines: readonly string[]): WordDiffLine[] {
    if (sideLines.length === 0) {
        return [];
    }
    if (baseLines.length === 0) {
        return sideLines.map((line) => ({
            tokens: line.length > 0 ? [{ text: line, changed: true }] : [],
        }));
    }
    if (arraysEqual(baseLines, sideLines)) {
        return sideLines.map((line) => ({
            tokens: line.length > 0 ? [{ text: line, changed: false }] : [],
        }));
    }

    const baseTokens = tokenizeForWordDiff(baseLines.join('\n'));
    const sideTokens = tokenizeForWordDiff(sideLines.join('\n'));
    const matches = computeMatchedPairs(baseTokens, sideTokens);
    const matchedSideIndices = new Set<number>(matches.map(([, sideIdx]) => sideIdx));

    const annotatedTokens: WordDiffToken[] = sideTokens.map((text, idx) => ({
        text,
        changed: !matchedSideIndices.has(idx),
    }));

    return splitTokensIntoLines(annotatedTokens, sideLines.length);
}

/**
 * Attempts a VS Code-style `smartCombineInputs` by merging token-level edits from
 * `firstLines` and `secondLines` relative to `baseLines`.
 * Returns `null` if any token-level replacement ranges conflict directly.
 */
function trySmartCombineLines(
    baseLines: readonly string[],
    firstLines: readonly string[],
    secondLines: readonly string[],
): string[] | null {
    if (baseLines.length === 0) {
        return null;
    }

    const baseTokens = tokenizeForWordDiff(baseLines.join('\n'));
    const firstTokens = tokenizeForWordDiff(firstLines.join('\n'));
    const secondTokens = tokenizeForWordDiff(secondLines.join('\n'));

    const firstEdits = computeSequenceEdits(baseTokens, firstTokens);
    const secondEdits = computeSequenceEdits(baseTokens, secondTokens);
    if (firstEdits.length === 0 || secondEdits.length === 0) {
        return null;
    }

    const combinedEdits: SequenceEdit<string>[] = [];
    let i1 = 0;
    let i2 = 0;

    while (i1 < firstEdits.length || i2 < secondEdits.length) {
        const e1 = firstEdits[i1];
        const e2 = secondEdits[i2];

        if (e1 && (!e2 || e1.baseEnd < e2.baseStart)) {
            combinedEdits.push(e1);
            i1++;
            continue;
        }
        if (e2 && (!e1 || e2.baseEnd < e1.baseStart)) {
            combinedEdits.push(e2);
            i2++;
            continue;
        }
        if (!e1 || !e2) {
            break;
        }

        // Identical token edit on both sides
        if (e1.baseStart === e2.baseStart && e1.baseEnd === e2.baseEnd && arraysEqual(e1.sideItems, e2.sideItems)) {
            combinedEdits.push(e1);
            i1++;
            i2++;
            continue;
        }

        // Adjacent edits touching at a boundary (e.g. e1.baseEnd === e2.baseStart or vice-versa)
        if (e1.baseEnd === e2.baseStart && (e1.baseStart < e1.baseEnd || e2.baseStart < e2.baseEnd)) {
            combinedEdits.push(e1, e2);
            i1++;
            i2++;
            continue;
        }
        if (e2.baseEnd === e1.baseStart && (e1.baseStart < e1.baseEnd || e2.baseStart < e2.baseEnd)) {
            combinedEdits.push(e2, e1);
            i1++;
            i2++;
            continue;
        }

        // Genuine token-level overlap on the same base tokens: cannot smart-combine
        return null;
    }

    // Apply combined token edits to baseTokens
    const resultTokens: string[] = [];
    let baseCursor = 0;
    for (const edit of combinedEdits) {
        if (edit.baseStart < baseCursor) {
            return null;
        }
        if (edit.baseStart > baseCursor) {
            resultTokens.push(...baseTokens.slice(baseCursor, edit.baseStart));
        }
        resultTokens.push(...edit.sideItems);
        baseCursor = edit.baseEnd;
    }
    if (baseCursor < baseTokens.length) {
        resultTokens.push(...baseTokens.slice(baseCursor));
    }

    const joined = resultTokens.join('');
    return joined.length === 0 ? [] : joined.split('\n');
}

/**
 * Determines whether a single edit overlaps a base interval `[clusterStart, clusterEnd)`.
 * Disjoint non-empty replacements that merely touch at `edit.baseStart === clusterEnd`
 * do NOT overlap so adjacent line modifications can auto-merge cleanly.
 */
function editOverlapsCluster(
    edit: BaseEdit,
    clusterStart: number,
    clusterEnd: number,
    clusterHasEmptyEditAtEnd: boolean,
): boolean {
    if (edit.baseStart < clusterEnd) {
        return true;
    }
    if (edit.baseStart > clusterEnd) {
        return false;
    }
    const editIsEmpty = edit.baseStart === edit.baseEnd;
    const clusterIsEmpty = clusterStart === clusterEnd;
    return editIsEmpty || clusterIsEmpty || clusterHasEmptyEditAtEnd;
}

/**
 * Returns true if `primaryEdit` finishes before `otherEdit` without conflicting.
 */
function isEditStrictlyBefore(
    primaryEdit: BaseEdit | undefined,
    otherEdit: BaseEdit | undefined,
): primaryEdit is BaseEdit {
    if (!primaryEdit) {
        return false;
    }
    if (!otherEdit) {
        return true;
    }
    if (primaryEdit.baseEnd < otherEdit.baseStart) {
        return true;
    }
    if (primaryEdit.baseEnd > otherEdit.baseStart) {
        return false;
    }
    const primaryNonEmpty = primaryEdit.baseEnd > primaryEdit.baseStart;
    const otherNonEmpty = otherEdit.baseEnd > otherEdit.baseStart;
    return primaryNonEmpty && otherNonEmpty;
}

function absorbEditIntoCluster(edit: BaseEdit, state: ConflictClusterState): void {
    if (edit.baseEnd > state.clusterBaseEnd) {
        state.clusterBaseEnd = edit.baseEnd;
        state.clusterHasEmptyEditAtEnd = false;
        return;
    }
    if (edit.baseStart === edit.baseEnd && edit.baseEnd === state.clusterBaseEnd) {
        state.clusterHasEmptyEditAtEnd = true;
    }
}

function absorbSideOverlappingEdits(
    edits: readonly BaseEdit[],
    startIndex: number,
    state: ConflictClusterState,
    onAbsorb: (edit: BaseEdit) => void,
): number {
    let idx = startIndex;
    while (
        idx < edits.length &&
        editOverlapsCluster(edits[idx], state.clusterBaseStart, state.clusterBaseEnd, state.clusterHasEmptyEditAtEnd)
    ) {
        const edit = edits[idx];
        onAbsorb(edit);
        absorbEditIntoCluster(edit, state);
        idx++;
    }
    return idx;
}

function collectConflictCluster(
    leftEdits: readonly BaseEdit[],
    rightEdits: readonly BaseEdit[],
    startLi: number,
    startRi: number,
    minBaseStart: number,
): ConflictClusterState {
    const nextL = leftEdits[startLi];
    const nextR = rightEdits[startRi];
    const initialEnd = Math.max(nextL ? nextL.baseEnd : minBaseStart, nextR ? nextR.baseEnd : minBaseStart);

    const state: ConflictClusterState = {
        clusterBaseStart: minBaseStart,
        clusterBaseEnd: initialEnd,
        li: startLi,
        ri: startRi,
        lastL: undefined,
        lastR: undefined,
        clusterHasEmptyEditAtEnd: false,
    };

    let progressed = true;
    while (progressed) {
        const nextLi = absorbSideOverlappingEdits(leftEdits, state.li, state, (edit) => {
            state.lastL = edit;
        });
        const nextRi = absorbSideOverlappingEdits(rightEdits, state.ri, state, (edit) => {
            state.lastR = edit;
        });
        progressed = nextLi !== state.li || nextRi !== state.ri;
        state.li = nextLi;
        state.ri = nextRi;
    }

    return state;
}

function resolveTrailingNewline(
    leftText: string,
    rightText: string,
    baseSplit: SplitLinesResult,
    leftSplit: SplitLinesResult,
    rightSplit: SplitLinesResult,
): boolean {
    if (leftText.length > 0 && rightText.length > 0) {
        return leftSplit.hasTrailingNewline || rightSplit.hasTrailingNewline;
    }
    if (leftText.length > 0) {
        return leftSplit.hasTrailingNewline;
    }
    if (rightText.length > 0) {
        return rightSplit.hasTrailingNewline;
    }
    return baseSplit.hasTrailingNewline;
}

/**
 * Combines two conflicting line blocks (`firstLines` followed by `secondLines`).
 * If `baseLines` is provided, first attempts a VS Code-style token-level smart merge
 * of non-overlapping intra-line/intra-hunk edits before falling back to line-level
 * prefix/suffix deduplication.
 */
export function combineConflictLines(
    firstLines: readonly string[],
    secondLines: readonly string[],
    baseLines?: readonly string[],
): string[] {
    if (baseLines && baseLines.length > 0) {
        const smart = trySmartCombineLines(baseLines, firstLines, secondLines);
        if (smart !== null) {
            return smart;
        }
    }

    const prefixLen = countCommonPrefix(firstLines, secondLines);
    const suffixLen = countCommonSuffix(firstLines, secondLines, prefixLen);

    const sharedPrefix = firstLines.slice(0, prefixLen);
    const sharedSuffix = suffixLen > 0 ? firstLines.slice(firstLines.length - suffixLen) : [];
    const firstMiddle = firstLines.slice(prefixLen, firstLines.length - suffixLen);
    const secondMiddle = secondLines.slice(prefixLen, secondLines.length - suffixLen);

    return [...sharedPrefix, ...firstMiddle, ...secondMiddle, ...sharedSuffix];
}

/**
 * Computes the resolved lines for a conflict hunk given a target resolution.
 */
export function getResolvedLinesForHunk(
    hunk: Pick<MergeConflictHunk, 'baseLines' | 'leftLines' | 'rightLines' | 'resolvedLines'>,
    resolution: ConflictResolution,
    customLines?: readonly string[],
): string[] {
    switch (resolution) {
        case 'left':
            return [...hunk.leftLines];
        case 'right':
            return [...hunk.rightLines];
        case 'both-left-first':
            return combineConflictLines(hunk.leftLines, hunk.rightLines, hunk.baseLines);
        case 'both-right-first':
            return combineConflictLines(hunk.rightLines, hunk.leftLines, hunk.baseLines);
        case 'base':
        case 'unhandled':
            return [...hunk.baseLines];
        case 'custom':
            return [...(customLines ?? hunk.resolvedLines)];
    }
}

function computeHandledFlagsForResolution(resolution: ConflictResolution): {
    leftHandled: boolean;
    rightHandled: boolean;
    handled: boolean;
} {
    if (resolution === 'unhandled') {
        return { leftHandled: false, rightHandled: false, handled: false };
    }
    return { leftHandled: true, rightHandled: true, handled: true };
}

/**
 * Infers the conflict resolution state from a candidate set of lines in the Result editor,
 * mirroring VS Code's `MergeEditorModel.computeState(baseRange)`.
 */
export function inferConflictResolutionFromLines(
    hunk: Pick<MergeConflictHunk, 'baseLines' | 'leftLines' | 'rightLines' | 'handled'>,
    candidateLines: readonly string[],
): ConflictResolution {
    const leftMatches = arraysEqual(candidateLines, hunk.leftLines);
    const rightMatches = arraysEqual(candidateLines, hunk.rightLines);
    const baseMatches = arraysEqual(candidateLines, hunk.baseLines);

    if (leftMatches && !rightMatches) {
        return 'left';
    }
    if (rightMatches && !leftMatches) {
        return 'right';
    }

    const bothLeftFirst = combineConflictLines(hunk.leftLines, hunk.rightLines, hunk.baseLines);
    if (arraysEqual(candidateLines, bothLeftFirst)) {
        return 'both-left-first';
    }

    const bothRightFirst = combineConflictLines(hunk.rightLines, hunk.leftLines, hunk.baseLines);
    if (arraysEqual(candidateLines, bothRightFirst)) {
        return 'both-right-first';
    }

    if (baseMatches) {
        return hunk.handled ? 'base' : 'unhandled';
    }

    return 'custom';
}

function updateResultLineRanges(segments: MergeSegment[]): MergeSegment[] {
    let resultCursor = 0;
    return segments.map((segment): MergeSegment => {
        const lines = segment.type === 'clean' ? segment.lines : segment.resolvedLines;
        const resultRange = makeLineRange(resultCursor, resultCursor + lines.length);
        resultCursor += lines.length;
        return {
            ...segment,
            resultRange,
        };
    });
}

function createCleanSegment(
    id: string,
    origin: AutoMergeOrigin,
    baseRange: MergeLineRange,
    leftRange: MergeLineRange,
    rightRange: MergeLineRange,
    baseLines: string[],
    leftLines: string[],
    rightLines: string[],
    lines: string[],
): MergeCleanSegment {
    const isModified = origin !== 'unchanged';
    return {
        type: 'clean',
        id,
        origin,
        accepted: true,
        baseRange,
        leftRange,
        rightRange,
        resultRange: makeLineRange(0, 0),
        baseLines,
        leftLines,
        rightLines,
        leftWordDiff: isModified ? computeWordDiffLines(baseLines, leftLines) : [],
        rightWordDiff: isModified ? computeWordDiffLines(baseLines, rightLines) : [],
        lines,
    };
}

function createConflictHunk(
    index: number,
    baseRange: MergeLineRange,
    leftRange: MergeLineRange,
    rightRange: MergeLineRange,
    baseLines: string[],
    leftLines: string[],
    rightLines: string[],
): MergeConflictHunk {
    const combinedLeftFirst = combineConflictLines(leftLines, rightLines, baseLines);
    const combinedRightFirst = combineConflictLines(rightLines, leftLines, baseLines);
    const isOrderRelevant = !arraysEqual(combinedLeftFirst, combinedRightFirst);

    return {
        type: 'conflict',
        id: `conflict-${index + 1}`,
        index,
        baseRange,
        leftRange,
        rightRange,
        resultRange: makeLineRange(0, 0),
        baseLines,
        leftLines,
        rightLines,
        leftWordDiff: computeWordDiffLines(baseLines, leftLines),
        rightWordDiff: computeWordDiffLines(baseLines, rightLines),
        resolution: 'unhandled',
        leftHandled: false,
        rightHandled: false,
        handled: false,
        isOrderRelevant,
        resolvedLines: [...baseLines],
    };
}

/**
 * Performs a deterministic 3-way merge of `baseText`, `leftText` (Side 1), and
 * `rightText` (Side 2). Non-conflicting changes (where only one side modified a
 * region, or both sides made the exact same modification) are automatically merged.
 */
export function computeThreeWayMerge(baseText: string, leftText: string, rightText: string): ThreeWayMergeDocument {
    const baseSplit = splitTextLines(baseText);
    const leftSplit = splitTextLines(leftText);
    const rightSplit = splitTextLines(rightText);

    const eol: '\n' | '\r\n' =
        leftSplit.eol === '\r\n' || rightSplit.eol === '\r\n' || baseSplit.eol === '\r\n' ? '\r\n' : '\n';
    const hasTrailingNewline = resolveTrailingNewline(leftText, rightText, baseSplit, leftSplit, rightSplit);

    const baseLines = baseSplit.lines;
    const leftLines = leftSplit.lines;
    const rightLines = rightSplit.lines;

    const leftEdits = computeLineEdits(baseLines, leftLines);
    const rightEdits = computeLineEdits(baseLines, rightLines);

    const rawSegments: MergeSegment[] = [];
    let li = 0;
    let ri = 0;
    let basePos = 0;
    let leftPos = 0;
    let rightPos = 0;
    let cleanCounter = 0;
    let conflictCounter = 0;

    const emitUnchangedUpTo = (targetBasePos: number): void => {
        if (targetBasePos <= basePos) {
            return;
        }
        const count = targetBasePos - basePos;
        const slice = baseLines.slice(basePos, targetBasePos);
        rawSegments.push(
            createCleanSegment(
                `clean-${++cleanCounter}`,
                'unchanged',
                makeLineRange(basePos, targetBasePos),
                makeLineRange(leftPos, leftPos + count),
                makeLineRange(rightPos, rightPos + count),
                slice,
                leftLines.slice(leftPos, leftPos + count),
                rightLines.slice(rightPos, rightPos + count),
                slice,
            ),
        );
        basePos += count;
        leftPos += count;
        rightPos += count;
    };

    while (li < leftEdits.length || ri < rightEdits.length) {
        const nextL = leftEdits[li];
        const nextR = rightEdits[ri];
        const minBaseStart = Math.min(nextL ? nextL.baseStart : Infinity, nextR ? nextR.baseStart : Infinity);

        emitUnchangedUpTo(minBaseStart);

        if (isEditStrictlyBefore(nextL, nextR)) {
            const baseCount = nextL.baseEnd - nextL.baseStart;
            const bSlice = baseLines.slice(nextL.baseStart, nextL.baseEnd);
            rawSegments.push(
                createCleanSegment(
                    `clean-${++cleanCounter}`,
                    'left',
                    makeLineRange(nextL.baseStart, nextL.baseEnd),
                    makeLineRange(nextL.sideStart, nextL.sideEnd),
                    makeLineRange(rightPos, rightPos + baseCount),
                    bSlice,
                    [...nextL.sideLines],
                    rightLines.slice(rightPos, rightPos + baseCount),
                    [...nextL.sideLines],
                ),
            );
            basePos = nextL.baseEnd;
            leftPos = nextL.sideEnd;
            rightPos += baseCount;
            li++;
            continue;
        }

        if (isEditStrictlyBefore(nextR, nextL)) {
            const baseCount = nextR.baseEnd - nextR.baseStart;
            const bSlice = baseLines.slice(nextR.baseStart, nextR.baseEnd);
            rawSegments.push(
                createCleanSegment(
                    `clean-${++cleanCounter}`,
                    'right',
                    makeLineRange(nextR.baseStart, nextR.baseEnd),
                    makeLineRange(leftPos, leftPos + baseCount),
                    makeLineRange(nextR.sideStart, nextR.sideEnd),
                    bSlice,
                    leftLines.slice(leftPos, leftPos + baseCount),
                    [...nextR.sideLines],
                    [...nextR.sideLines],
                ),
            );
            basePos = nextR.baseEnd;
            leftPos += baseCount;
            rightPos = nextR.sideEnd;
            ri++;
            continue;
        }

        const cluster = collectConflictCluster(leftEdits, rightEdits, li, ri, minBaseStart);
        li = cluster.li;
        ri = cluster.ri;

        const clusterBaseStart = cluster.clusterBaseStart;
        const clusterBaseEnd = cluster.clusterBaseEnd;
        const clusterLeftStart = leftPos;
        const clusterLeftEnd = cluster.lastL
            ? cluster.lastL.sideEnd + (clusterBaseEnd - cluster.lastL.baseEnd)
            : leftPos + (clusterBaseEnd - clusterBaseStart);
        const clusterRightStart = rightPos;
        const clusterRightEnd = cluster.lastR
            ? cluster.lastR.sideEnd + (clusterBaseEnd - cluster.lastR.baseEnd)
            : rightPos + (clusterBaseEnd - clusterBaseStart);

        const clusterBaseLines = baseLines.slice(clusterBaseStart, clusterBaseEnd);
        const clusterLeftLines = leftLines.slice(clusterLeftStart, clusterLeftEnd);
        const clusterRightLines = rightLines.slice(clusterRightStart, clusterRightEnd);

        basePos = clusterBaseEnd;
        leftPos = clusterLeftEnd;
        rightPos = clusterRightEnd;

        if (arraysEqual(clusterLeftLines, clusterRightLines)) {
            rawSegments.push(
                createCleanSegment(
                    `clean-${++cleanCounter}`,
                    'both-identical',
                    makeLineRange(clusterBaseStart, clusterBaseEnd),
                    makeLineRange(clusterLeftStart, clusterLeftEnd),
                    makeLineRange(clusterRightStart, clusterRightEnd),
                    clusterBaseLines,
                    clusterLeftLines,
                    clusterRightLines,
                    [...clusterLeftLines],
                ),
            );
            continue;
        }

        const index = conflictCounter++;
        rawSegments.push(
            createConflictHunk(
                index,
                makeLineRange(clusterBaseStart, clusterBaseEnd),
                makeLineRange(clusterLeftStart, clusterLeftEnd),
                makeLineRange(clusterRightStart, clusterRightEnd),
                clusterBaseLines,
                clusterLeftLines,
                clusterRightLines,
            ),
        );
    }

    emitUnchangedUpTo(baseLines.length);

    return {
        segments: updateResultLineRanges(rawSegments),
        eol,
        hasTrailingNewline,
    };
}

/**
 * Returns a new `ThreeWayMergeDocument` with the specified conflict hunk updated.
 */
export function resolveConflictHunk(
    doc: ThreeWayMergeDocument,
    hunkId: string,
    resolution: ConflictResolution,
    customLines?: readonly string[],
): ThreeWayMergeDocument {
    const segments = doc.segments.map((segment): MergeSegment => {
        if (segment.type !== 'conflict' || segment.id !== hunkId) {
            return segment;
        }
        const resolvedLines = getResolvedLinesForHunk(segment, resolution, customLines);
        const flags = computeHandledFlagsForResolution(resolution);
        return {
            ...segment,
            resolution,
            ...flags,
            resolvedLines,
        };
    });

    return {
        ...doc,
        segments: updateResultLineRanges(segments),
    };
}

/**
 * Marks one side of a conflict hunk as handled ("Ignore") without accepting its changes,
 * matching VS Code's `Ignore` CodeLens action (`setHandled(baseRange, inputNumber, true)`).
 */
export function ignoreConflictSide(
    doc: ThreeWayMergeDocument,
    hunkId: string,
    side: 'left' | 'right',
): ThreeWayMergeDocument {
    const segments = doc.segments.map((segment): MergeSegment => {
        if (segment.type !== 'conflict' || segment.id !== hunkId) {
            return segment;
        }

        const leftHandled = side === 'left' ? true : segment.leftHandled;
        const rightHandled = side === 'right' ? true : segment.rightHandled;
        const handled = leftHandled && rightHandled;

        let nextResolution = segment.resolution;
        if (side === 'left') {
            if (segment.resolution === 'left') {
                nextResolution = handled ? 'base' : 'unhandled';
            } else if (segment.resolution === 'both-left-first' || segment.resolution === 'both-right-first') {
                nextResolution = 'right';
            }
        } else {
            if (segment.resolution === 'right') {
                nextResolution = handled ? 'base' : 'unhandled';
            } else if (segment.resolution === 'both-left-first' || segment.resolution === 'both-right-first') {
                nextResolution = 'left';
            }
        }
        if (nextResolution === 'unhandled' && handled) {
            nextResolution = 'base';
        }

        return {
            ...segment,
            resolution: nextResolution,
            leftHandled,
            rightHandled,
            handled,
            resolvedLines: getResolvedLinesForHunk(segment, nextResolution),
        };
    });

    return {
        ...doc,
        segments: updateResultLineRanges(segments),
    };
}

/**
 * Toggles the `handled` state of a conflict hunk in the Result pane (e.g. `Mark as Handled`
 * when keeping the Base version with `No Changes Accepted`).
 */
export function toggleConflictHandled(doc: ThreeWayMergeDocument, hunkId: string): ThreeWayMergeDocument {
    const segments = doc.segments.map((segment): MergeSegment => {
        if (segment.type !== 'conflict' || segment.id !== hunkId) {
            return segment;
        }
        const nextHandled = !segment.handled;
        const nextResolution =
            segment.resolution === 'unhandled' && nextHandled
                ? 'base'
                : segment.resolution === 'base' && !nextHandled
                  ? 'unhandled'
                  : segment.resolution;
        return {
            ...segment,
            resolution: nextResolution,
            leftHandled: nextHandled,
            rightHandled: nextHandled,
            handled: nextHandled,
        };
    });

    return {
        ...doc,
        segments: updateResultLineRanges(segments),
    };
}

/**
 * Toggles whether a non-conflicting auto-merged segment is accepted or reverted to Base.
 */
export function toggleAutoMergedSegment(doc: ThreeWayMergeDocument, segmentId: string): ThreeWayMergeDocument {
    const segments = doc.segments.map((segment): MergeSegment => {
        if (segment.type !== 'clean' || segment.id !== segmentId || segment.origin === 'unchanged') {
            return segment;
        }
        const nextAccepted = !segment.accepted;
        const acceptedLines = segment.origin === 'right' ? segment.rightLines : segment.leftLines;
        return {
            ...segment,
            accepted: nextAccepted,
            lines: nextAccepted ? [...acceptedLines] : [...segment.baseLines],
        };
    });

    return {
        ...doc,
        segments: updateResultLineRanges(segments),
    };
}

/**
 * Synchronizes a `ThreeWayMergeDocument` after the user edits the full Result text directly,
 * preserving edits across both clean and conflict segments and inferring each conflict hunk's
 * updated `ConflictResolution` (`left`, `right`, `both-*`, `base`, or `custom`).
 */
export function syncMergeDocumentFromResultText(
    doc: ThreeWayMergeDocument,
    newResultText: string,
): ThreeWayMergeDocument {
    const oldLines: string[] = [];
    const oldBoundaries: number[] = [0];
    for (const segment of doc.segments) {
        const segLines = segment.type === 'clean' ? segment.lines : segment.resolvedLines;
        oldLines.push(...segLines);
        oldBoundaries.push(oldLines.length);
    }

    const newSplit = splitTextLines(newResultText);
    const newLines = newSplit.lines;
    if (arraysEqual(oldLines, newLines)) {
        return doc;
    }

    const matches = computeMatchedPairs(oldLines, newLines);
    const newBoundaries = new Array<number>(doc.segments.length + 1).fill(0);
    newBoundaries[0] = 0;
    newBoundaries[doc.segments.length] = newLines.length;

    let matchCursor = 0;
    for (let s = 1; s < doc.segments.length; s++) {
        const oldBoundary = oldBoundaries[s];
        while (matchCursor < matches.length && matches[matchCursor][0] < oldBoundary) {
            matchCursor++;
        }
        const prevBoundary = newBoundaries[s - 1];
        if (matchCursor < matches.length && matches[matchCursor][0] === oldBoundary) {
            newBoundaries[s] = Math.max(prevBoundary, matches[matchCursor][1]);
            continue;
        }
        if (matchCursor > 0) {
            const [prevOld, prevNew] = matches[matchCursor - 1];
            const delta = oldBoundary - prevOld;
            newBoundaries[s] = Math.min(newLines.length, Math.max(prevBoundary, prevNew + delta));
            continue;
        }
        newBoundaries[s] = Math.min(newLines.length, Math.max(prevBoundary, oldBoundary));
    }

    const updatedSegments = doc.segments.map((segment, idx): MergeSegment => {
        const start = newBoundaries[idx];
        const end = Math.max(start, newBoundaries[idx + 1]);
        const slice = newLines.slice(start, end);

        if (segment.type === 'clean') {
            if (arraysEqual(segment.lines, slice)) {
                return segment;
            }
            const accepted =
                segment.origin === 'unchanged'
                    ? true
                    : arraysEqual(slice, segment.origin === 'right' ? segment.rightLines : segment.leftLines);
            return {
                ...segment,
                accepted,
                lines: slice,
            };
        }

        if (arraysEqual(segment.resolvedLines, slice)) {
            return segment;
        }

        const inferred = inferConflictResolutionFromLines(segment, slice);
        const flags = computeHandledFlagsForResolution(inferred);
        return {
            ...segment,
            resolution: inferred,
            ...flags,
            resolvedLines: slice,
        };
    });

    return {
        ...doc,
        segments: updateResultLineRanges(updatedSegments),
        hasTrailingNewline: newResultText.length > 0 ? newSplit.hasTrailingNewline : doc.hasTrailingNewline,
    };
}

/**
 * Resolves all conflict hunks in the document using the specified resolution
 * (e.g. `'left'` or `'right'`). If `onlyUnhandled` is true, already-resolved hunks
 * are preserved.
 */
export function resolveAllConflicts(
    doc: ThreeWayMergeDocument,
    resolution: 'left' | 'right' | 'both-left-first' | 'both-right-first' | 'unhandled',
    onlyUnhandled: boolean = false,
): ThreeWayMergeDocument {
    const segments = doc.segments.map((segment): MergeSegment => {
        if (segment.type !== 'conflict') {
            return segment;
        }
        if (onlyUnhandled && segment.handled) {
            return segment;
        }
        const flags = computeHandledFlagsForResolution(resolution);
        return {
            ...segment,
            resolution,
            ...flags,
            resolvedLines: getResolvedLinesForHunk(segment, resolution),
        };
    });

    return {
        ...doc,
        segments: updateResultLineRanges(segments),
    };
}

/**
 * Renders the current merged output string from a `ThreeWayMergeDocument`.
 */
export function renderMergedContent(doc: ThreeWayMergeDocument): string {
    const outputLines: string[] = [];
    for (const segment of doc.segments) {
        const segmentLines = segment.type === 'clean' ? segment.lines : segment.resolvedLines;
        outputLines.push(...segmentLines);
    }
    return joinTextLines(outputLines, doc.eol, doc.hasTrailingNewline);
}

interface ParsedConflictBlock {
    base: string[];
    left: string[];
    right: string[];
    nextIndex: number;
}

function appendJjDiffLine(line: string, diffBase: string[], diffTarget: string[]): void {
    if (line.startsWith('-')) {
        diffBase.push(line.slice(1));
        return;
    }
    if (line.startsWith('+')) {
        diffTarget.push(line.slice(1));
        return;
    }
    const stripped = line.startsWith(' ') ? line.slice(1) : line;
    diffBase.push(stripped);
    diffTarget.push(stripped);
}

function parseJjConflictBlock(blockLines: readonly string[]): { base: string[]; left: string[]; right: string[] } {
    type JjSectionMode = 'none' | 'jj-diff' | 'jj-plus' | 'jj-minus';
    let mode: JjSectionMode = 'none';
    let currentBuf: string[] = [];
    let currentDiffBase: string[] = [];
    let currentDiffTarget: string[] = [];

    const snapshots: string[][] = [];
    const baseSnapshots: string[][] = [];
    const diffSections: { base: string[]; target: string[] }[] = [];

    const flushSection = (): void => {
        if (mode === 'jj-plus') {
            snapshots.push(currentBuf);
        } else if (mode === 'jj-minus') {
            baseSnapshots.push(currentBuf);
        } else if (mode === 'jj-diff') {
            diffSections.push({ base: currentDiffBase, target: currentDiffTarget });
        }
        currentBuf = [];
        currentDiffBase = [];
        currentDiffTarget = [];
    };

    for (const line of blockLines) {
        if (line.startsWith('%%%%%%%')) {
            flushSection();
            mode = 'jj-diff';
            continue;
        }
        if (line.startsWith('+++++++')) {
            flushSection();
            mode = 'jj-plus';
            continue;
        }
        if (line.startsWith('-------')) {
            flushSection();
            mode = 'jj-minus';
            continue;
        }
        if (line.startsWith('\\\\\\\\\\\\\\')) {
            continue;
        }
        if (mode === 'jj-diff') {
            appendJjDiffLine(line, currentDiffBase, currentDiffTarget);
            continue;
        }
        currentBuf.push(line);
    }

    flushSection();

    if (diffSections.length > 0 && snapshots.length > 0) {
        return {
            base: diffSections[0].base,
            left: diffSections[0].target,
            right: snapshots[snapshots.length - 1],
        };
    }

    if (snapshots.length >= 2) {
        return {
            base: baseSnapshots[0] ?? [],
            left: snapshots[0],
            right: snapshots[1],
        };
    }

    return { base: [], left: [], right: [] };
}

function parseGitConflictBlock(blockLines: readonly string[]): { base: string[]; left: string[]; right: string[] } {
    type GitSectionMode = 'left' | 'base' | 'right';
    let mode: GitSectionMode = 'left';
    const left: string[] = [];
    const base: string[] = [];
    const right: string[] = [];

    for (const line of blockLines) {
        if (line.startsWith('|||||||')) {
            mode = 'base';
            continue;
        }
        if (line.startsWith('=======')) {
            mode = 'right';
            continue;
        }
        if (mode === 'left') {
            left.push(line);
            continue;
        }
        if (mode === 'base') {
            base.push(line);
            continue;
        }
        right.push(line);
    }

    return { base, left, right };
}

function parseSingleConflictBlock(lines: readonly string[], startMarkerIndex: number): ParsedConflictBlock {
    let endIdx = startMarkerIndex + 1;
    while (endIdx < lines.length && !lines[endIdx].startsWith('>>>>>>>')) {
        endIdx++;
    }

    const blockLines = lines.slice(startMarkerIndex + 1, endIdx);
    const isJjStyle = blockLines.some(
        (l) => l.startsWith('%%%%%%%') || l.startsWith('+++++++') || l.startsWith('-------'),
    );
    const parsed = isJjStyle ? parseJjConflictBlock(blockLines) : parseGitConflictBlock(blockLines);
    const nextIndex = endIdx < lines.length ? endIdx + 1 : endIdx;

    return {
        ...parsed,
        nextIndex,
    };
}

/**
 * Fallback parser for extracting `{ base, left, right }` from a file containing
 * JJ diff/snapshot conflict markers (`<<<<<<<`, `%%%%%%%`, `+++++++`, `-------`, `>>>>>>>`)
 * or Git/diff3 conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`).
 * Returns `null` if no conflict markers are present.
 */
export function parseConflictMarkersFallback(rawContent: string): { base: string; left: string; right: string } | null {
    const split = splitTextLines(rawContent);
    const lines = split.lines;
    if (!lines.some((l) => l.startsWith('<<<<<<<'))) {
        return null;
    }

    const baseLines: string[] = [];
    const leftLines: string[] = [];
    const rightLines: string[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.startsWith('<<<<<<<')) {
            baseLines.push(line);
            leftLines.push(line);
            rightLines.push(line);
            i++;
            continue;
        }

        const block = parseSingleConflictBlock(lines, i);
        baseLines.push(...block.base);
        leftLines.push(...block.left);
        rightLines.push(...block.right);
        i = block.nextIndex;
    }

    return {
        base: joinTextLines(baseLines, split.eol, split.hasTrailingNewline),
        left: joinTextLines(leftLines, split.eol, split.hasTrailingNewline),
        right: joinTextLines(rightLines, split.eol, split.hasTrailingNewline),
    };
}
