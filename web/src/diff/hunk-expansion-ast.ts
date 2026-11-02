/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileDiffMetadata } from '@pierre/diffs';

export const MINIMUM_LINES_TO_HIDE = 4;
export const DEFAULT_COLLAPSED_CONTEXT_THRESHOLD = 4;
export const DEFAULT_LINE_HEIGHT_PX = 20;

export interface SyntaxBlockRange {
    start_line: number;
    end_line: number;
}

export interface SyntaxBlock {
    name: string;
    range: SyntaxBlockRange;
    children: SyntaxBlock[];
}

export interface AstBlockTarget {
    block: SyntaxBlock;
    path: readonly SyntaxBlock[];
    refLine: number;
    targetLine: number;
    count: number;
    codePreview: string;
}

export interface AstBlockTargets {
    below: AstBlockTarget | null; // Expanding downward from upper hunk (above the fold)
    above: AstBlockTarget | null; // Expanding upward from lower hunk (below the fold)
}

export interface HunkGapLineRanges {
    rangeSize: number;
    remaining: number;
    fromStart: number;
    fromEnd: number;
    firstHiddenNew: number | null;
    lastHiddenNew: number | null;
    firstHiddenOld: number | null;
    lastHiddenOld: number | null;
}

export interface ExpandedHunkRegion {
    fromStart: number;
    fromEnd: number;
}

export const SEAM_SVGS = {
    arrowDown:
        '<svg viewBox="0 0 16 16" width="11" height="11" style="flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowUp:
        '<svg viewBox="0 0 16 16" width="11" height="11" style="flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 13V3M4.5 6.5L8 3l3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unfold: '<svg viewBox="0 0 16 16" width="12" height="12" style="flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5.5 5L8 2.5 10.5 5M5.5 11L8 13.5 10.5 11M3 8h10" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    braces: '<svg viewBox="0 0 16 16" width="11" height="11" style="flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5.5 3C4.2 3 4 3.8 4 5v1.5C4 7.3 3.3 8 2.5 8c.8 0 1.5.7 1.5 1.5V11c0 1.2.2 2 1.5 2M10.5 3c1.3 0 1.5.8 1.5 2v1.5c0 .8.7 1.5 1.5 1.5-.8 0-1.5.7-1.5 1.5V11c0 1.2-.2 2-1.5 2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gripDots:
        '<svg class="grip-dots" viewBox="0 0 10 14" width="8" height="11" style="flex-shrink:0" fill="currentColor"><circle cx="3" cy="3" r="1.1"/><circle cx="7" cy="3" r="1.1"/><circle cx="3" cy="7" r="1.1"/><circle cx="7" cy="7" r="1.1"/><circle cx="3" cy="11" r="1.1"/><circle cx="7" cy="11" r="1.1"/></svg>',
    chevronRight:
        '<svg viewBox="0 0 16 16" width="10" height="10" style="flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
} as const;

export type SeamSvgName = 'arrowDown' | 'arrowUp' | 'unfold' | 'braces' | 'gripDots' | 'chevronRight';

export function createSvgIcon(name: SeamSvgName): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.flexShrink = '0';
    if (name === 'arrowDown') {
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '11');
        svg.setAttribute('height', '11');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M8 3v10M4.5 9.5L8 13l3.5-3.5');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        return svg;
    }
    if (name === 'arrowUp') {
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '11');
        svg.setAttribute('height', '11');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M8 13V3M4.5 6.5L8 3l3.5 3.5');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        return svg;
    }
    if (name === 'unfold') {
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.7');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5.5 5L8 2.5 10.5 5M5.5 11L8 13.5 10.5 11M3 8h10');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        return svg;
    }
    if (name === 'braces') {
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '11');
        svg.setAttribute('height', '11');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.7');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute(
            'd',
            'M5.5 3C4.2 3 4 3.8 4 5v1.5C4 7.3 3.3 8 2.5 8c.8 0 1.5.7 1.5 1.5V11c0 1.2.2 2 1.5 2M10.5 3c1.3 0 1.5.8 1.5 2v1.5c0 .8.7 1.5 1.5 1.5-.8 0-1.5.7-1.5 1.5V11c0 1.2-.2 2-1.5 2',
        );
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        return svg;
    }
    if (name === 'gripDots') {
        svg.setAttribute('class', 'grip-dots');
        svg.setAttribute('viewBox', '0 0 10 14');
        svg.setAttribute('width', '8');
        svg.setAttribute('height', '11');
        svg.setAttribute('fill', 'currentColor');
        const coords = [
            [3, 3],
            [7, 3],
            [3, 7],
            [7, 7],
            [3, 11],
            [7, 11],
        ] as const;
        for (const [cx, cy] of coords) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', String(cx));
            circle.setAttribute('cy', String(cy));
            circle.setAttribute('r', '1.1');
            svg.appendChild(circle);
        }
        return svg;
    }
    if (name === 'chevronRight') {
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '10');
        svg.setAttribute('height', '10');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M6 4l4 4-4 4');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        return svg;
    }
    return svg;
}

export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Resolves the hierarchical path of SyntaxBlocks containing the given line number.
 * Strict inequalities (range.start_line < lineNum && range.end_line > lineNum)
 * guarantee that once a block's boundary line is reached, the next click steps
 * out to the enclosing parent SyntaxBlock automatically.
 */
export function findBlockTreePathForLine(lineNum: number, blocks?: readonly SyntaxBlock[]): SyntaxBlock[] {
    if (!blocks || blocks.length === 0) {
        return [];
    }
    const containingBlock = blocks.find(({ range }) => range.start_line < lineNum && range.end_line > lineNum);
    if (!containingBlock) {
        return [];
    }
    return [containingBlock, ...findBlockTreePathForLine(lineNum, containingBlock.children)];
}

/**
 * Stub-fold clamping rule:
 * Any expansion that would leave fewer than MINIMUM_LINES_TO_HIDE (4) hidden lines
 * remaining automatically clamps to expand the full remainder.
 */
export function clampExpansionLines(requestedLines: number, remainingLines: number): number {
    if (remainingLines <= 0) {
        return 0;
    }
    const count = Math.min(requestedLines, remainingLines);
    const leftOver = remainingLines - count;
    if (leftOver > 0 && leftOver < MINIMUM_LINES_TO_HIDE) {
        return remainingLines;
    }
    return count;
}

export function isCharacterEscaped(str: string, index: number): boolean {
    let backslashCount = 0;
    for (let i = index - 1; i >= 0 && str[i] === '\\'; i--) {
        backslashCount++;
    }
    return backslashCount % 2 === 1;
}

function isFullyParenthesized(str: string): boolean {
    if (!str.startsWith('(') || !str.endsWith(')')) {
        return false;
    }
    let depth = 0;
    for (let i = 0; i < str.length - 1; i++) {
        if (str[i] === '(') {
            depth++;
        } else if (str[i] === ')') {
            depth--;
        }
        if (depth === 0) {
            return false;
        }
    }
    return depth === 1;
}

export function cleanBlockHeaderName(text: string): string {
    const trimmed = text.trim();

    // 1. Python def / async def
    const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
    if (defMatch) {
        return `${defMatch[1]}()`;
    }

    // 2. Class / struct / interface / enum / type
    const clsStruct = trimmed.match(/\b(?:class|struct|interface|enum|type)\s+([A-Za-z0-9_]+)/);
    if (clsStruct) {
        return clsStruct[1];
    }

    // 3. Simple parameterless block headers (try:, finally:, else:)
    const simpleKw = trimmed.match(/^(try|finally|else)\b\s*[:{]?$/);
    if (simpleKw) {
        return simpleKw[1];
    }

    // 4. Bare except:
    if (/^except\b\s*:?$/.test(trimmed)) {
        return 'except';
    }

    // 5. Control keywords with condition/expression:
    // else if, async for, async with, elif, except, with, for, while, if, match, case, switch, catch
    const condMatch = trimmed.match(
        /^(else\s+if|async\s+for|async\s+with|elif|except|with|for|while|if|match|case|switch|catch)\b\s*(.*)$/,
    );
    if (condMatch) {
        const kw = condMatch[1];
        let expr = (condMatch[2] ?? '').trim();
        expr = expr.replace(/\s*(?:#|\/\/).*$/, '').trim();
        expr = expr.replace(/[:{]\s*$/, '').trim();
        if (isFullyParenthesized(expr)) {
            expr = expr.slice(1, -1).trim();
        }
        if (expr.length === 0) {
            return kw;
        }
        const condBrief = expr.length > 25 ? `${expr.slice(0, 22)}...` : expr;
        return `${kw} (${condBrief})`;
    }

    // 6. Namespace / package
    const ns = trimmed.match(/\b(?:namespace|package)\s+([A-Za-z0-9_:]+)/);
    if (ns) {
        return ns[1];
    }

    // 7. Generic function calls / signatures
    const fnMatch = trimmed.match(/(?:[A-Za-z0-9_<>&*:[\],\s]+?\s+)?([A-Za-z0-9_~:]+)\s*\([^)]*\)/);
    if (fnMatch) {
        const raw = fnMatch[1];
        const shortName = raw.includes('::') ? (raw.split('::').pop() ?? raw) : raw;
        return `${shortName}()`;
    }

    if (trimmed.length > 0 && trimmed.length <= 25 && !trimmed.includes('{')) {
        return trimmed;
    }
    return '{...}';
}

function parseBraceSyntaxBlocks(lines: readonly string[]): SyntaxBlock[] {
    interface OpenBlock {
        name: string;
        start_line: number;
        children: SyntaxBlock[];
    }

    const stack: OpenBlock[] = [];
    const rootBlocks: SyntaxBlock[] = [];
    let inMultiLineComment = false;
    let lastNonEmptyLine = '';
    let lastNonEmptyLineNum = 1;

    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const rawLine = lines[i] ?? '';
        let inQuote: string | null = null;
        let textBeforeBrace = '';

        for (let charIdx = 0; charIdx < rawLine.length; charIdx++) {
            const ch = rawLine[charIdx];
            const nextCh = charIdx + 1 < rawLine.length ? rawLine[charIdx + 1] : '';

            // Handle multi-line comment state
            if (inMultiLineComment) {
                if (ch === '*' && nextCh === '/') {
                    inMultiLineComment = false;
                    charIdx++;
                }
                continue;
            }

            // Handle string literal state
            if (inQuote !== null) {
                if (ch === inQuote && !isCharacterEscaped(rawLine, charIdx)) {
                    inQuote = null;
                }
                continue;
            }

            // Outside quotes and comments:
            // 1. Multi-line comment open: /*
            if (ch === '/' && nextCh === '*') {
                inMultiLineComment = true;
                charIdx++;
                continue;
            }

            // 2. Single-line comment: //
            if (ch === '/' && nextCh === '/') {
                break;
            }

            // 3. Hash comment or preprocessor: #
            if (ch === '#') {
                break;
            }

            // 4. String open
            if (ch === '"' || ch === "'" || ch === '`') {
                inQuote = ch;
                continue;
            }

            // 5. Opening brace {
            if (ch === '{') {
                let decl = textBeforeBrace.trim();
                let declLine = lineNum;

                if (decl.length === 0) {
                    decl = lastNonEmptyLine.trim();
                    declLine = lastNonEmptyLineNum;
                }

                let pDepth = 0;
                let hasUnmatchedClosingParen = false;
                for (const c of decl) {
                    if (c === '(') {
                        pDepth++;
                    } else if (c === ')') {
                        pDepth--;
                        if (pDepth < 0) {
                            hasUnmatchedClosingParen = true;
                            break;
                        }
                    }
                }

                // If decl starts with ')' or '):' or '->' or similar multi-line return type,
                // or contains an unmatched closing ')' from multi-line parameter signatures,
                // scan backward up to 6 lines to find the matching opening '(' for the function signature
                if (
                    decl.startsWith(')') ||
                    /^\)\s*(?:const|override|final|noexcept|mutable|throws|->|:)/.test(decl) ||
                    hasUnmatchedClosingParen
                ) {
                    for (let lookback = i - 1; lookback >= Math.max(0, i - 6); lookback--) {
                        const prevLine = lines[lookback] ?? '';
                        if (prevLine.includes('(')) {
                            decl = `${prevLine.trim()} ${decl}`;
                            declLine = lookback + 1;
                            break;
                        }
                    }
                }

                if (decl.length === 0) {
                    decl = rawLine.trim();
                }

                const name = cleanBlockHeaderName(decl);
                stack.push({
                    name,
                    start_line: declLine,
                    children: [],
                });
                textBeforeBrace = '';
            } else if (ch === '}') {
                if (stack.length > 0) {
                    const closed = stack.pop();
                    if (closed) {
                        const end_line = lineNum;
                        if (end_line > closed.start_line) {
                            const block: SyntaxBlock = {
                                name: closed.name,
                                range: { start_line: closed.start_line, end_line },
                                children: closed.children,
                            };
                            if (stack.length > 0) {
                                stack[stack.length - 1].children.push(block);
                            } else {
                                rootBlocks.push(block);
                            }
                        }
                    }
                }
                textBeforeBrace = '';
            } else {
                textBeforeBrace += ch;
            }
        }

        const trimmedRaw = rawLine.trim();
        if (
            trimmedRaw.length > 0 &&
            !trimmedRaw.startsWith('//') &&
            !trimmedRaw.startsWith('/*') &&
            !inMultiLineComment
        ) {
            lastNonEmptyLine = rawLine;
            lastNonEmptyLineNum = lineNum;
        }
    }

    // Handle unclosed top-level blocks at EOF if any
    while (stack.length > 0) {
        const unclosed = stack.pop();
        if (unclosed && lines.length > unclosed.start_line) {
            const block: SyntaxBlock = {
                name: unclosed.name,
                range: { start_line: unclosed.start_line, end_line: lines.length },
                children: unclosed.children,
            };
            if (stack.length > 0) {
                stack[stack.length - 1].children.push(block);
            } else {
                rootBlocks.push(block);
            }
        }
    }

    return rootBlocks;
}

function parseIndentationSyntaxBlocks(lines: readonly string[]): SyntaxBlock[] {
    interface IndentBlock {
        name: string;
        indent: number;
        start_line: number;
        children: SyntaxBlock[];
    }

    const stack: IndentBlock[] = [];
    const rootBlocks: SyntaxBlock[] = [];
    const PYTHON_BLOCK_KEYWORD_REGEX =
        /^(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b/;

    let inTripleQuote: '"""' | "'''" | null = null;
    let parenDepth = 0;
    let pendingHeader: { text: string; startLine: number; indent: number } | null = null;
    let lastCodeLineNum = 1;

    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const rawLine = lines[i] ?? '';
        const trimmed = rawLine.trim();

        // Handle continuation inside multi-line triple quote
        let charIdx = 0;
        if (inTripleQuote !== null) {
            const closeIdx = rawLine.indexOf(inTripleQuote, charIdx);
            if (closeIdx === -1) {
                // Entire line is inside triple-quoted string
                continue;
            }
            inTripleQuote = null;
            charIdx = closeIdx + 3;
        }

        // Ignore empty lines and full comment lines for indentation changes
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
            continue;
        }

        const indentMatch = rawLine.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1].length : 0;

        // When not inside parentheses/arguments and not collecting a multi-line header:
        // check if indentation has decreased to pop completed blocks
        if (parenDepth === 0 && pendingHeader === null) {
            while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
                const popped = stack.pop();
                if (popped) {
                    const end_line = Math.max(popped.start_line, lastCodeLineNum);
                    if (end_line > popped.start_line) {
                        const block: SyntaxBlock = {
                            name: popped.name,
                            range: { start_line: popped.start_line, end_line },
                            children: popped.children,
                        };
                        if (stack.length > 0) {
                            stack[stack.length - 1].children.push(block);
                        } else {
                            rootBlocks.push(block);
                        }
                    }
                }
            }
        }

        // Scan characters of the line to update parenDepth, inTripleQuote, strings, and comments
        let lineCode = '';
        let inSingleQuote: string | null = null;

        while (charIdx < rawLine.length) {
            if (inSingleQuote === null) {
                if (rawLine.startsWith('"""', charIdx) || rawLine.startsWith("'''", charIdx)) {
                    const q = rawLine.slice(charIdx, charIdx + 3) as '"""' | "'''";
                    charIdx += 3;
                    const closeIdx = rawLine.indexOf(q, charIdx);
                    if (closeIdx !== -1) {
                        charIdx = closeIdx + 3;
                        continue;
                    }
                    inTripleQuote = q;
                    break;
                }
            }

            const ch = rawLine[charIdx];

            if (inSingleQuote !== null) {
                lineCode += ch;
                if (ch === inSingleQuote && !isCharacterEscaped(rawLine, charIdx)) {
                    inSingleQuote = null;
                }
                charIdx++;
                continue;
            }

            if (ch === '"' || ch === "'") {
                lineCode += ch;
                inSingleQuote = ch;
                charIdx++;
                continue;
            }

            if (ch === '#') {
                break;
            }

            lineCode += ch;

            if (ch === '(' || ch === '[' || ch === '{') {
                parenDepth++;
            } else if (ch === ')' || ch === ']' || ch === '}') {
                if (parenDepth > 0) {
                    parenDepth--;
                }
            }

            charIdx++;
        }

        const codeTrimmed = lineCode.trim();
        if (codeTrimmed.length > 0) {
            lastCodeLineNum = lineNum;
        }

        if (pendingHeader !== null) {
            pendingHeader.text += ` ${codeTrimmed}`;
            if (parenDepth === 0 && inTripleQuote === null && codeTrimmed.endsWith(':')) {
                const name = cleanBlockHeaderName(pendingHeader.text);
                stack.push({
                    name,
                    indent: pendingHeader.indent,
                    start_line: pendingHeader.startLine,
                    children: [],
                });
                pendingHeader = null;
            } else if (parenDepth === 0 && !codeTrimmed.endsWith(':') && !codeTrimmed.endsWith('\\')) {
                pendingHeader = null;
            }
        } else if (PYTHON_BLOCK_KEYWORD_REGEX.test(codeTrimmed)) {
            if (parenDepth === 0 && inTripleQuote === null && codeTrimmed.endsWith(':')) {
                const name = cleanBlockHeaderName(codeTrimmed);
                stack.push({
                    name,
                    indent,
                    start_line: lineNum,
                    children: [],
                });
            } else if (parenDepth > 0 || codeTrimmed.endsWith('\\')) {
                // Multi-line header (open paren or backslash continuation)
                pendingHeader = {
                    text: codeTrimmed,
                    startLine: lineNum,
                    indent,
                };
            }
        }
    }

    while (stack.length > 0) {
        const popped = stack.pop();
        if (popped) {
            const end_line = Math.max(popped.start_line, lastCodeLineNum);
            if (end_line > popped.start_line) {
                const block: SyntaxBlock = {
                    name: popped.name,
                    range: { start_line: popped.start_line, end_line },
                    children: popped.children,
                };
                if (stack.length > 0) {
                    stack[stack.length - 1].children.push(block);
                } else {
                    rootBlocks.push(block);
                }
            }
        }
    }

    return rootBlocks;
}

/**
 * Builds a hierarchy of SyntaxBlocks across C++, TS, JS, GN, Python, Go, Rust, Java.
 */
export function buildSyntaxBlocks(lines: readonly string[], fileName?: string): SyntaxBlock[] {
    if (!lines || lines.length === 0) {
        return [];
    }

    if (fileName) {
        if (/\.(py|pyi|pyw|star|bzl)$/i.test(fileName)) {
            return parseIndentationSyntaxBlocks(lines);
        }
        if (
            /\.(c|cc|cpp|cxx|h|hpp|hh|ino|ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|go|java|kt|swift|cs|gn|gni|css|scss|less|json|jsonc)$/i.test(
                fileName,
            )
        ) {
            return parseBraceSyntaxBlocks(lines);
        }
    }

    if (lines.length > 0 && /^#!.*python/.test(lines[0])) {
        return parseIndentationSyntaxBlocks(lines);
    }

    const sampleLimit = Math.min(lines.length, 500);
    let pythonColonHeaders = 0;
    let definitivePythonHeaders = 0;
    let braceHeaders = 0;
    let rawBraceCount = 0;

    // Exclude 'case' from generic regex since C/C++/TS uses switch-case:
    const PYTHON_HEADER_REGEX =
        /^\s*(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match)\b.*:\s*(?:#.*)?$/;
    const DEFINITIVE_PYTHON_REGEX = /^\s*(?:async\s+)?(?:def|elif|except|finally)\b.*:\s*(?:#.*)?$/;
    const BRACE_HEADER_REGEX = /\{\s*(?:\/\/.*|#.*)?$/;

    for (let i = 0; i < sampleLimit; i++) {
        const line = lines[i] ?? '';
        if (PYTHON_HEADER_REGEX.test(line)) {
            pythonColonHeaders++;
        }
        if (DEFINITIVE_PYTHON_REGEX.test(line)) {
            definitivePythonHeaders++;
        }
        if (BRACE_HEADER_REGEX.test(line) || /^\s*\{\s*$/.test(line)) {
            braceHeaders++;
        }
        if (line.includes('{') || line.includes('}')) {
            rawBraceCount++;
        }
    }

    if (
        (definitivePythonHeaders > 0 && braceHeaders === 0) ||
        (pythonColonHeaders > 0 && braceHeaders === 0) ||
        (pythonColonHeaders > braceHeaders && pythonColonHeaders >= 2)
    ) {
        return parseIndentationSyntaxBlocks(lines);
    }

    if (rawBraceCount > 0) {
        return parseBraceSyntaxBlocks(lines);
    }
    return parseIndentationSyntaxBlocks(lines);
}

function getHunkSideStartBoundary(start: number, count: number): number {
    return start - (count === 0 ? 0 : 1);
}

function getHunkSideEndBoundary(start: number, count: number): number {
    return getHunkSideStartBoundary(start, count) + count;
}

/**
 * Calculates 1-based hidden line ranges for both additions (new file) and deletions (old file).
 */
export function getHunkGapLineRanges(
    fileDiff: FileDiffMetadata | null | undefined,
    hunkIndex: number,
    expandedRegion: ExpandedHunkRegion,
    newFileLines?: readonly string[],
): HunkGapLineRanges {
    const result: HunkGapLineRanges = {
        rangeSize: 0,
        remaining: 0,
        fromStart: expandedRegion.fromStart,
        fromEnd: expandedRegion.fromEnd,
        firstHiddenNew: null,
        lastHiddenNew: null,
        firstHiddenOld: null,
        lastHiddenOld: null,
    };

    if (!fileDiff?.hunks || fileDiff.hunks.length === 0) {
        return result;
    }

    if (hunkIndex < fileDiff.hunks.length) {
        const hunk = fileDiff.hunks[hunkIndex];
        const rangeSize = Math.max(hunk.collapsedBefore ?? 0, 0);
        result.rangeSize = rangeSize;
        const remaining = Math.max(0, rangeSize - expandedRegion.fromStart - expandedRegion.fromEnd);
        result.remaining = remaining;
        if (rangeSize === 0) {
            return result;
        }

        const newHunkStart = getHunkSideStartBoundary(hunk.additionStart, hunk.additionCount) + 1;
        const newGapStart = newHunkStart - rangeSize;
        result.firstHiddenNew = newGapStart + expandedRegion.fromStart;
        result.lastHiddenNew = newHunkStart - 1 - expandedRegion.fromEnd;

        const oldHunkStart = getHunkSideStartBoundary(hunk.deletionStart, hunk.deletionCount) + 1;
        const oldGapStart = oldHunkStart - rangeSize;
        result.firstHiddenOld = oldGapStart + expandedRegion.fromStart;
        result.lastHiddenOld = oldHunkStart - 1 - expandedRegion.fromEnd;
        return result;
    }

    // Trailing gap after the final hunk
    const lastHunk = fileDiff.hunks[fileDiff.hunks.length - 1];
    const trailingNewStart = getHunkSideEndBoundary(lastHunk.additionStart, lastHunk.additionCount) + 1;
    const trailingOldStart = getHunkSideEndBoundary(lastHunk.deletionStart, lastHunk.deletionCount) + 1;
    let totalNewLines = fileDiff.additionLines?.length ?? newFileLines?.length ?? 0;
    if (totalNewLines === 0 && !newFileLines && fileDiff.type === 'deleted') {
        totalNewLines = fileDiff.deletionLines?.length ?? 0;
    }
    const rangeSize = Math.max(0, totalNewLines - (trailingNewStart - 1));
    result.rangeSize = rangeSize;
    const remaining = Math.max(0, rangeSize - expandedRegion.fromStart);
    result.remaining = remaining;
    if (rangeSize === 0) {
        return result;
    }

    result.firstHiddenNew = trailingNewStart + expandedRegion.fromStart;
    result.lastHiddenNew = trailingNewStart + rangeSize - 1;
    result.firstHiddenOld = trailingOldStart + expandedRegion.fromStart;
    result.lastHiddenOld = trailingOldStart + rangeSize - 1;
    return result;
}

function computeTargetBelow(
    gap: HunkGapLineRanges,
    syntaxBlocks: readonly SyntaxBlock[],
    newFileLines?: readonly string[],
): AstBlockTarget | null {
    if (gap.firstHiddenNew === null || gap.lastHiddenNew === null) {
        return null;
    }
    const refLineBelow = gap.firstHiddenNew - 1;
    const treePathBelow = findBlockTreePathForLine(refLineBelow, syntaxBlocks);
    if (treePathBelow.length === 0) {
        return null;
    }
    const targetBlock = treePathBelow[treePathBelow.length - 1];
    const targetLine = Math.min(targetBlock.range.end_line, gap.lastHiddenNew);
    if (targetLine < gap.firstHiddenNew) {
        return null;
    }
    const rawCount = targetLine - refLineBelow;
    const count = clampExpansionLines(rawCount, gap.remaining);
    if (count <= 0) {
        return null;
    }
    const rawPreview = newFileLines?.[targetLine - 1] ?? '';
    return {
        block: targetBlock,
        path: treePathBelow,
        refLine: refLineBelow,
        targetLine,
        count,
        codePreview: rawPreview.trim(),
    };
}

function computeTargetAbove(
    gap: HunkGapLineRanges,
    syntaxBlocks: readonly SyntaxBlock[],
    newFileLines?: readonly string[],
): AstBlockTarget | null {
    if (gap.firstHiddenNew === null || gap.lastHiddenNew === null) {
        return null;
    }
    const refLineAbove = gap.lastHiddenNew + 1;
    const treePathAbove = findBlockTreePathForLine(refLineAbove, syntaxBlocks);
    if (treePathAbove.length === 0) {
        return null;
    }
    const targetBlock = treePathAbove[treePathAbove.length - 1];
    const targetLine = Math.max(targetBlock.range.start_line, gap.firstHiddenNew);
    if (targetLine > gap.lastHiddenNew) {
        return null;
    }
    const rawCount = refLineAbove - targetLine;
    const count = clampExpansionLines(rawCount, gap.remaining);
    if (count <= 0) {
        return null;
    }
    const rawPreview = newFileLines?.[targetLine - 1] ?? '';
    return {
        block: targetBlock,
        path: treePathAbove,
        refLine: refLineAbove,
        targetLine,
        count,
        codePreview: rawPreview.trim(),
    };
}

/**
 * Calculates BLOCK_BELOW (top-docked) and BLOCK_ABOVE (bottom-docked)
 * targets using findBlockTreePathForLine.
 */
export function computeAstBlockTargets(
    fileDiff: FileDiffMetadata | null | undefined,
    hunkIndex: number,
    expandedRegion: ExpandedHunkRegion,
    syntaxBlocks: readonly SyntaxBlock[],
    newFileLines?: readonly string[],
): AstBlockTargets {
    const gap = getHunkGapLineRanges(fileDiff, hunkIndex, expandedRegion, newFileLines);
    if (gap.remaining <= 0 || gap.firstHiddenNew === null || gap.lastHiddenNew === null) {
        return { below: null, above: null };
    }

    const hunksCount = fileDiff?.hunks?.length ?? 0;
    const below = hunkIndex > 0 ? computeTargetBelow(gap, syntaxBlocks, newFileLines) : null;
    const above = hunkIndex < hunksCount ? computeTargetAbove(gap, syntaxBlocks, newFileLines) : null;

    return { below, above };
}

export function formatBreadcrumbPathHtml(path: readonly SyntaxBlock[]): string {
    return path
        .map((b, idx) => {
            const cls = idx === path.length - 1 ? 'fn' : 'ty';
            return `<span class="${cls}">${escapeHtml(b.name)}</span>`;
        })
        .join(` ${SEAM_SVGS.chevronRight} `);
}

export function formatLineRangeTag(prefix: 'Old' | 'New', start: number | null, end: number | null): string {
    if (start === null || end === null || start <= 0 || end <= 0) {
        return '';
    }
    if (start === end) {
        return `${prefix} ${start}`;
    }
    return `${prefix} ${start}..${end}`;
}
