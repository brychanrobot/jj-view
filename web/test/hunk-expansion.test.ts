/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileDiffMetadata, Hunk } from '@pierre/diffs';
import type { ThemeRegistration } from 'shiki';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureThemeSelectionBackground } from '../src/diff/highlighter-setup';
import {
    type AstBlockTarget,
    adoptDiffCustomStyles,
    buildSyntaxBlocks,
    buildSyntaxBlocksFromDiff,
    clampExpansionLines,
    cleanBlockHeaderName,
    computeAstBlockTargets,
    DEFAULT_LINE_HEIGHT_PX,
    type ExpandedHunkRegion,
    enhanceCodeViewDiffItemSeparators,
    findBlockTreePathForLine,
    flattenSyntaxBlocks,
    formatBreadcrumbPathHtml,
    formatLineRangeTag,
    formatXmlHtmlBlockName,
    getHunkGapLineRanges,
    HunkExpansionController,
    type HunkExpansionControllerHost,
    JjFileDiff,
    mergeSyntaxBlockTrees,
    parseXmlHtmlSyntaxBlocks,
    type SyntaxBlock,
    startSeamInteraction,
} from '../src/diff/hunk-expansion';
import { createMock } from './test-mock';

function createMockHunk(overrides: Partial<Hunk> = {}): Hunk {
    return createMock<Hunk>({
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 1,
        deletionStart: 1,
        deletionCount: 1,
        additionLines: 0,
        deletionLines: 0,
        additionLineIndex: 0,
        deletionLineIndex: 0,
        hunkContent: [],
        noEOFCRAdditions: false,
        noEOFCRDeletions: false,
        ...overrides,
    });
}

function createMockFileDiff(overrides: Partial<FileDiffMetadata> = {}): FileDiffMetadata {
    return createMock<FileDiffMetadata>({
        name: 'test.cc',
        type: 'change',
        isPartial: false,
        splitLineCount: 100,
        unifiedLineCount: 100,
        additionLines: [],
        deletionLines: [],
        hunks: [],
        ...overrides,
    });
}

function isHtmlElement(node: unknown): node is HTMLElement {
    return typeof node === 'object' && node !== null && 'tagName' in node;
}

interface MutableParentNode {
    parentElement: HTMLElement | null;
}

function setParentElement(target: unknown, parent: HTMLElement | null): void {
    if (typeof target === 'object' && target !== null && 'parentElement' in target) {
        (target as MutableParentNode).parentElement = parent;
    }
}

function createFakeDom() {
    function matchesSelector(el: HTMLElement, selector: string): boolean {
        const parts = selector.match(/\[[^\]]+\]|\.[^.[]+|[a-zA-Z0-9_-]+/g);
        if (!parts || parts.length === 0) {
            return false;
        }
        return parts.every((part) => {
            if (part.startsWith('.')) {
                const cls = part.slice(1);
                return el.className.split(/\s+/).includes(cls);
            }
            if (part.startsWith('[') && part.endsWith(']')) {
                const attrExpr = part.slice(1, -1);
                const eqIdx = attrExpr.indexOf('=');
                if (eqIdx === -1) {
                    return el.hasAttribute(attrExpr);
                }
                const attrName = attrExpr.slice(0, eqIdx);
                const expectedVal = attrExpr.slice(eqIdx + 1).replace(/['"]/g, '');
                return el.getAttribute(attrName) === expectedVal;
            }
            return el.tagName.toLowerCase() === part.toLowerCase();
        });
    }

    interface FakeElementData {
        tagName: string;
        title: string;
        className: string;
        textContent: string;
        parentElement: HTMLElement | null;
        children: HTMLElement[];
        attributes: Map<string, string>;
        classes: Set<string>;
        styleProps: Record<string, string>;
    }

    function makeElement(tagName: string): HTMLElement {
        const data: FakeElementData = {
            tagName: tagName.toUpperCase(),
            title: '',
            className: '',
            textContent: '',
            parentElement: null,
            children: [],
            attributes: new Map<string, string>(),
            classes: new Set<string>(),
            styleProps: {},
        };

        const el: HTMLElement = createMock<HTMLElement>({
            get tagName() {
                return data.tagName;
            },
            get title() {
                return data.title;
            },
            set title(val: string) {
                data.title = val;
            },
            get parentElement() {
                return data.parentElement;
            },
            set parentElement(p: HTMLElement | null) {
                data.parentElement = p;
            },
            get style() {
                const styleObj: Partial<CSSStyleDeclaration> = {};
                return createMock<CSSStyleDeclaration>(
                    new Proxy(styleObj, {
                        has(_target, _prop) {
                            return true;
                        },
                        set(_target, prop, value) {
                            if (typeof prop === 'string') {
                                data.styleProps[prop] = String(value);
                            }
                            return true;
                        },
                        get(_target, prop) {
                            if (prop === 'setProperty') {
                                return (key: string, val: string) => {
                                    data.styleProps[key] = val;
                                };
                            }
                            if (prop === 'removeProperty') {
                                return (key: string) => {
                                    delete data.styleProps[key];
                                    return '';
                                };
                            }
                            if (prop === 'getPropertyValue') {
                                return (key: string) => data.styleProps[key] ?? '';
                            }
                            if (typeof prop === 'string') {
                                return data.styleProps[prop] ?? '';
                            }
                            return '';
                        },
                    }),
                );
            },
            get classList() {
                return createMock<DOMTokenList>({
                    add: (cls: string) => {
                        data.classes.add(cls);
                        data.className = Array.from(data.classes).join(' ');
                    },
                    remove: (cls: string) => {
                        data.classes.delete(cls);
                        data.className = Array.from(data.classes).join(' ');
                    },
                    contains: (cls: string) => data.classes.has(cls),
                });
            },
            get className() {
                return data.className;
            },
            set className(val: string) {
                data.classes.clear();
                for (const c of val.split(/\s+/).filter(Boolean)) {
                    data.classes.add(c);
                }
                data.className = Array.from(data.classes).join(' ');
            },
            get textContent() {
                if (data.children.length > 0) {
                    return data.children.map((c) => c.textContent || '').join('');
                }
                return data.textContent;
            },
            set textContent(val: string) {
                data.textContent = val;
                data.children = [];
            },
            setAttribute: (name: string, value: string) => {
                data.attributes.set(name, value);
            },
            getAttribute: (name: string) => data.attributes.get(name) ?? null,
            hasAttribute: (name: string) => data.attributes.has(name),
            removeAttribute: (name: string) => {
                data.attributes.delete(name);
            },
            appendChild: <T extends Node>(child: T): T => {
                setParentElement(child, el);
                if (isHtmlElement(child)) {
                    data.children.push(child);
                }
                return child;
            },
            append: (...nodes: (Node | string)[]) => {
                for (const node of nodes) {
                    if (typeof node === 'string') {
                        const span = makeElement('span');
                        span.textContent = node;
                        el.appendChild(span);
                    } else if (isHtmlElement(node)) {
                        el.appendChild(node);
                    }
                }
            },
            replaceChildren: (...nodes: (Node | string)[]) => {
                data.children = [];
                el.append(...nodes);
            },
            addEventListener: (_type: string, _listener: EventListenerOrEventListenerObject) => {},
            querySelector: <E extends Element = Element>(selector: string): E | null => {
                for (const child of data.children) {
                    if (matchesSelector(child, selector)) {
                        return createMock<E>(child as object);
                    }
                    const nested = child.querySelector<E>(selector);
                    if (nested) {
                        return nested;
                    }
                }
                return null;
            },
            querySelectorAll: <E extends Element = Element>(selector: string): NodeListOf<E> => {
                const results: E[] = [];
                for (const child of data.children) {
                    if (matchesSelector(child, selector)) {
                        results.push(createMock<E>(child as object));
                    }
                    const nested = child.querySelectorAll<E>(selector);
                    results.push(...Array.from(nested));
                }
                const listObj: Partial<NodeListOf<E>> = {
                    length: results.length,
                    item: (idx: number) => results[idx] ?? null,
                    forEach: (cb: (value: E, key: number, parent: NodeListOf<E>) => void) => {
                        for (let i = 0; i < results.length; i++) {
                            cb(results[i], i, createMock<NodeListOf<E>>());
                        }
                    },
                };
                for (let i = 0; i < results.length; i++) {
                    listObj[i] = results[i];
                }
                return createMock<NodeListOf<E>>(listObj);
            },
            closest: <E extends Element = Element>(selector: string): E | null => {
                let current: HTMLElement | null = el;
                while (current) {
                    if (matchesSelector(current, selector)) {
                        return createMock<E>(current as object);
                    }
                    current = current.parentElement;
                }
                return null;
            },
        });

        return el;
    }

    const fakeDocument = createMock<Document>({
        createElement: (tag: string) => makeElement(tag),
        createElementNS: createMock<Document['createElementNS']>((_ns: string | null, tag: string) => {
            return makeElement(tag);
        }),
        body: createMock<HTMLElement>({
            classList: createMock<DOMTokenList>({
                add: () => {},
                remove: () => {},
                contains: () => false,
            }),
        }),
    });

    return { fakeDocument, makeElement };
}

describe('Hunk Expansion & AST +Block Engine', () => {
    describe('buildSyntaxBlocks', () => {
        it('parses nested C++ classes, methods, and control blocks', () => {
            const cppLines = [
                'namespace ui {', // L1
                'class WindowController {', // L2
                ' public:', // L3
                '  void Close(CloseReason reason) {', // L4
                '    RecordMetric(reason);', // L5
                '    if (widget_) {', // L6
                '      widget_->Hide();', // L7
                '      widget_.reset();', // L8
                '    }', // L9
                '    current_mode_ = kHidden;', // L10
                '  }', // L11
                '  void ShowDetached() {', // L12
                '    CreateWidget();', // L13
                '  }', // L14
                '};', // L15
                '}  // namespace ui', // L16
            ];

            const blocks = buildSyntaxBlocks(cppLines);
            expect(blocks.length).toBe(1);
            const ns = blocks[0];
            expect(ns.name).toBe('ui');
            expect(ns.range).toEqual({ start_line: 1, end_line: 16 });

            expect(ns.children.length).toBe(1);
            const cls = ns.children[0];
            expect(cls.name).toBe('WindowController');
            expect(cls.range).toEqual({ start_line: 2, end_line: 15 });

            expect(cls.children.length).toBe(2);
            const closeFn = cls.children[0];
            expect(closeFn.name).toBe('Close()');
            expect(closeFn.range).toEqual({ start_line: 4, end_line: 11 });

            expect(closeFn.children.length).toBe(1);
            const ifBlock = closeFn.children[0];
            expect(ifBlock.name).toBe('if (widget_)');
            expect(ifBlock.range).toEqual({ start_line: 6, end_line: 9 });

            const showFn = cls.children[1];
            expect(showFn.name).toBe('ShowDetached()');
            expect(showFn.range).toEqual({ start_line: 12, end_line: 14 });
        });

        it('handles Allman style where opening brace is on its own line', () => {
            const allmanLines = [
                'void ShowDetached(WindowMode mode)', // L1
                '{', // L2
                '  DCHECK_EQ(mode, kDetached);', // L3
                '}', // L4
            ];
            const blocks = buildSyntaxBlocks(allmanLines);
            expect(blocks.length).toBe(1);
            expect(blocks[0].name).toBe('ShowDetached()');
            expect(blocks[0].range.start_line).toBe(1);
            expect(blocks[0].range.end_line).toBe(4);
        });

        it("handles multi-line C++ signatures where final parameter and ')' share the '{' line", () => {
            const lines = [
                'void WindowController::ShowDetached(', // L1
                '    WindowMode mode,', // L2
                '    bool activate) {', // L3
                '  DCHECK_EQ(mode, kDetached);', // L4
                '}', // L5
            ];
            const blocks = buildSyntaxBlocks(lines, 'window_controller.cc');
            expect(blocks.length).toBe(1);
            expect(blocks[0].name).toBe('ShowDetached()');
            expect(blocks[0].range).toEqual({ start_line: 1, end_line: 5 });
        });

        it('cleans C++ signatures with template return types containing commas', () => {
            expect(cleanBlockHeaderName('std::pair<int, int> GetBounds()')).toBe('GetBounds()');
            expect(cleanBlockHeaderName('const std::map<std::string, int>& GetCounts()')).toBe('GetCounts()');
        });

        it('ignores braces inside strings and comments', () => {
            const codeLines = [
                'void LogBraces() {', // L1
                '  // comment with { ignored', // L2
                '  /* block comment { ignored', // L3
                '     still ignored } */', // L4
                '  std::string s = "{not a block}";', // L5
                '}', // L6
            ];
            const blocks = buildSyntaxBlocks(codeLines);
            expect(blocks.length).toBe(1);
            expect(blocks[0].name).toBe('LogBraces()');
            expect(blocks[0].range).toEqual({ start_line: 1, end_line: 6 });
            expect(blocks[0].children.length).toBe(0);
        });

        it('does not corrupt URLs or wildcards inside strings before opening brace', () => {
            const codeLines = [
                'const endpoint = "https://example.com/api";', // L1
                'const pattern = "src/*";', // L2
                'function initialize() {', // L3
                '    const url = "https://example.org/test";', // L4
                '    return url;', // L5
                '}', // L6
            ];
            const blocks = buildSyntaxBlocks(codeLines);
            expect(blocks.length).toBe(1);
            expect(blocks[0].name).toBe('initialize()');
            expect(blocks[0].range).toEqual({ start_line: 3, end_line: 6 });
        });

        it('parses Python indentation blocks when file has no braces', () => {
            const pyLines = [
                'class WindowController:', // L1
                '    def close(self):', // L2
                '        if self.widget:', // L3
                '            self.widget.hide()', // L4
                '        self.mode = None', // L5
                '    def show(self):', // L6
                '        self.create()', // L7
            ];
            const blocks = buildSyntaxBlocks(pyLines);
            expect(blocks.length).toBe(1);
            const cls = blocks[0];
            expect(cls.name).toBe('WindowController');
            expect(cls.range.start_line).toBe(1);
            expect(cls.range.end_line).toBe(7);

            expect(cls.children.length).toBe(2);
            const closeFn = cls.children[0];
            expect(closeFn.name).toBe('close()');
            expect(closeFn.range.start_line).toBe(2);
            expect(closeFn.range.end_line).toBe(5);

            expect(closeFn.children.length).toBe(1);
            expect(closeFn.children[0].name).toBe('if (self.widget)');
            expect(closeFn.children[0].range.start_line).toBe(3);
            expect(closeFn.children[0].range.end_line).toBe(4);
        });
    });

    describe('findBlockTreePathForLine', () => {
        const blocksFixture: SyntaxBlock[] = [
            {
                name: 'ui',
                range: { start_line: 1, end_line: 90 },
                children: [
                    {
                        name: 'WindowController',
                        range: { start_line: 10, end_line: 88 },
                        children: [
                            {
                                name: 'Close()',
                                range: { start_line: 11, end_line: 33 },
                                children: [
                                    {
                                        name: 'if (widget_)',
                                        range: { start_line: 14, end_line: 25 },
                                        children: [],
                                    },
                                ],
                            },
                            {
                                name: 'ShowDetached()',
                                range: { start_line: 38, end_line: 68 },
                                children: [
                                    {
                                        name: 'if (attached_browser)',
                                        range: { start_line: 52, end_line: 66 },
                                        children: [],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ];

        it('returns innermost containing path using strict inequality', () => {
            const path19 = findBlockTreePathForLine(19, blocksFixture);
            expect(path19.map((b) => b.name)).toEqual(['ui', 'WindowController', 'Close()', 'if (widget_)']);
        });

        it('automatically steps out to parent block on subsequent click when boundary line is reached', () => {
            const path25 = findBlockTreePathForLine(25, blocksFixture);
            expect(path25.map((b) => b.name)).toEqual(['ui', 'WindowController', 'Close()']);

            const path33 = findBlockTreePathForLine(33, blocksFixture);
            expect(path33.map((b) => b.name)).toEqual(['ui', 'WindowController']);
        });

        it('steps out to enclosing parent for upward expansion when start_line is reached', () => {
            const path60 = findBlockTreePathForLine(60, blocksFixture);
            expect(path60.map((b) => b.name)).toEqual([
                'ui',
                'WindowController',
                'ShowDetached()',
                'if (attached_browser)',
            ]);

            const path52 = findBlockTreePathForLine(52, blocksFixture);
            expect(path52.map((b) => b.name)).toEqual(['ui', 'WindowController', 'ShowDetached()']);
        });

        it('returns empty array when line sits outside all blocks', () => {
            expect(findBlockTreePathForLine(0, blocksFixture)).toEqual([]);
            expect(findBlockTreePathForLine(1, blocksFixture)).toEqual([]);
            expect(findBlockTreePathForLine(90, blocksFixture)).toEqual([]);
            expect(findBlockTreePathForLine(100, blocksFixture)).toEqual([]);
        });
    });

    describe('clampExpansionLines (Stub-fold Clamping)', () => {
        it('clamps expansions that would leave fewer than 4 lines remaining', () => {
            expect(clampExpansionLines(10, 12)).toBe(12);
            expect(clampExpansionLines(10, 13)).toBe(13);
            expect(clampExpansionLines(10, 11)).toBe(11);
            expect(clampExpansionLines(6, 8)).toBe(8);
        });

        it('allows partial expansion when 4 or more lines remain', () => {
            expect(clampExpansionLines(10, 14)).toBe(10);
            expect(clampExpansionLines(10, 25)).toBe(10);
        });

        it('returns remaining when requested exceeds or equals remaining', () => {
            expect(clampExpansionLines(10, 10)).toBe(10);
            expect(clampExpansionLines(10, 5)).toBe(5);
            expect(clampExpansionLines(10, 0)).toBe(0);
            expect(clampExpansionLines(10, -3)).toBe(0);
        });
    });

    describe('getHunkGapLineRanges', () => {
        function createTestDiff(): FileDiffMetadata {
            return createMockFileDiff({
                name: 'test.cc',
                additionLines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`),
                deletionLines: Array.from({ length: 100 }, (_, i) => `old ${i + 1}`),
                hunks: [
                    createMockHunk({
                        collapsedBefore: 20, // Gap: lines 1..20
                        additionStart: 21,
                        additionCount: 10, // Hunk 0: lines 21..30
                        deletionStart: 21,
                        deletionCount: 10,
                    }),
                    createMockHunk({
                        collapsedBefore: 30, // Gap: lines 31..60
                        additionStart: 61,
                        additionCount: 10, // Hunk 1: lines 61..70
                        deletionStart: 61,
                        deletionCount: 10,
                    }),
                ],
            });
        }

        it('computes line ranges for leading gap (hunk 0)', () => {
            const diff = createTestDiff();
            const region: ExpandedHunkRegion = { fromStart: 0, fromEnd: 0 };
            const gap = getHunkGapLineRanges(diff, 0, region);
            expect(gap.rangeSize).toBe(20);
            expect(gap.remaining).toBe(20);
            expect(gap.firstHiddenNew).toBe(1);
            expect(gap.lastHiddenNew).toBe(20);
        });

        it('computes line ranges for intermediate gap (hunk 1)', () => {
            const diff = createTestDiff();
            const region: ExpandedHunkRegion = { fromStart: 5, fromEnd: 3 };
            const gap = getHunkGapLineRanges(diff, 1, region);
            expect(gap.rangeSize).toBe(30);
            expect(gap.remaining).toBe(22);
            expect(gap.firstHiddenNew).toBe(36);
            expect(gap.lastHiddenNew).toBe(57);
        });

        it('computes line ranges for trailing gap after last hunk', () => {
            const diff = createTestDiff();
            const region: ExpandedHunkRegion = { fromStart: 10, fromEnd: 0 };
            const gap = getHunkGapLineRanges(diff, 2, region);
            expect(gap.rangeSize).toBe(30);
            expect(gap.remaining).toBe(20);
            expect(gap.firstHiddenNew).toBe(81);
            expect(gap.lastHiddenNew).toBe(100);
        });
    });

    describe('computeAstBlockTargets', () => {
        function createAstDiffFixture(): {
            diff: FileDiffMetadata;
            blocks: SyntaxBlock[];
            lines: string[];
        } {
            const lines = Array.from({ length: 80 }, (_, i) => `// Line ${i + 1}`);
            lines[10] = 'void Close() {';
            lines[13] = '  if (widget_) {';
            lines[24] = '  }';
            lines[32] = '}';
            lines[37] = 'void ShowDetached() {';
            lines[51] = '  if (attached_browser) {';
            lines[65] = '  }';
            lines[67] = '}';

            const blocks: SyntaxBlock[] = [
                {
                    name: 'Close()',
                    range: { start_line: 11, end_line: 33 },
                    children: [
                        {
                            name: 'if (widget_)',
                            range: { start_line: 14, end_line: 25 },
                            children: [],
                        },
                    ],
                },
                {
                    name: 'ShowDetached()',
                    range: { start_line: 38, end_line: 68 },
                    children: [
                        {
                            name: 'if (attached_browser)',
                            range: { start_line: 52, end_line: 66 },
                            children: [],
                        },
                    ],
                },
            ];

            const diff = createMockFileDiff({
                name: 'controller.cc',
                additionLines: lines,
                deletionLines: lines,
                hunks: [
                    createMockHunk({
                        collapsedBefore: 10,
                        additionStart: 11,
                        additionCount: 9,
                        deletionStart: 11,
                        deletionCount: 9,
                    }),
                    createMockHunk({
                        collapsedBefore: 40,
                        additionStart: 60,
                        additionCount: 9,
                        deletionStart: 60,
                        deletionCount: 9,
                    }),
                ],
            });

            return { diff, blocks, lines };
        }

        it('computes top-docked and bottom-docked AST block targets in a hidden gap', () => {
            const { diff, blocks, lines } = createAstDiffFixture();
            const region: ExpandedHunkRegion = { fromStart: 0, fromEnd: 0 };
            const targets = computeAstBlockTargets(diff, 1, region, blocks, lines);

            expect(targets.below).not.toBeNull();
            expect(targets.below?.block.name).toBe('if (widget_)');
            expect(targets.below?.targetLine).toBe(25);
            expect(targets.below?.count).toBe(6);

            expect(targets.above).not.toBeNull();
            expect(targets.above?.block.name).toBe('if (attached_browser)');
            expect(targets.above?.targetLine).toBe(52);
            expect(targets.above?.count).toBe(8);
        });

        it('omits top-docked target on leading gap (hunk 0)', () => {
            const { diff, blocks, lines } = createAstDiffFixture();
            const region: ExpandedHunkRegion = { fromStart: 0, fromEnd: 0 };
            const targets = computeAstBlockTargets(diff, 0, region, blocks, lines);
            expect(targets.below).toBeNull();
        });

        it('omits bottom-docked target on trailing gap', () => {
            const { diff, blocks, lines } = createAstDiffFixture();
            const region: ExpandedHunkRegion = { fromStart: 0, fromEnd: 0 };
            const targets = computeAstBlockTargets(diff, 2, region, blocks, lines);
            expect(targets.above).toBeNull();
        });

        it('progressively steps out to outer function block on subsequent expansion', () => {
            const { diff, blocks, lines } = createAstDiffFixture();
            const region: ExpandedHunkRegion = { fromStart: 6, fromEnd: 0 };
            const targets = computeAstBlockTargets(diff, 1, region, blocks, lines);

            expect(targets.below).not.toBeNull();
            expect(targets.below?.block.name).toBe('Close()');
            expect(targets.below?.targetLine).toBe(33);
            expect(targets.below?.count).toBe(8);
        });
    });

    describe('UI Formatting Helpers', () => {
        it('formats breadcrumb paths with vector chevron separators', () => {
            const path: SyntaxBlock[] = [
                { name: 'ui', range: { start_line: 1, end_line: 90 }, children: [] },
                {
                    name: 'Close()',
                    range: { start_line: 10, end_line: 30 },
                    children: [],
                },
            ];
            const html = formatBreadcrumbPathHtml(path);
            expect(html).toContain('<span class="ty">ui</span>');
            expect(html).toContain('<span class="fn">Close()</span>');
            expect(html).toContain('svg');
        });

        it('formats line range tags correctly', () => {
            expect(formatLineRangeTag('New', 20, 59)).toBe('New 20..59');
            expect(formatLineRangeTag('Old', 15, 15)).toBe('Old 15');
            expect(formatLineRangeTag('Old', null, null)).toBe('');
            expect(formatLineRangeTag('New', 0, 0)).toBe('');
        });
    });

    describe('Monotonic Drag Math Invariants', () => {
        it('scrubs 1:1 with rendered line height and guarantees Math.max monotonicity', () => {
            const lineHeightPx = DEFAULT_LINE_HEIGHT_PX;
            const totalHidden = 40;
            let fromStart = 0;
            const baseFromStart = 0;

            const delta1 = 45;
            const add1 = Math.floor(delta1 / lineHeightPx);
            fromStart = Math.max(fromStart, baseFromStart + add1);
            expect(fromStart).toBe(2);

            const delta2 = 85;
            const add2 = Math.floor(delta2 / lineHeightPx);
            fromStart = Math.max(fromStart, baseFromStart + add2);
            expect(fromStart).toBe(4);

            const deltaBack = 30;
            const addBack = Math.floor(deltaBack / lineHeightPx);
            fromStart = Math.max(fromStart, baseFromStart + addBack);
            expect(fromStart).toBe(4);

            const delta3 = 120;
            const add3 = Math.floor(delta3 / lineHeightPx);
            fromStart = Math.max(fromStart, baseFromStart + add3);
            expect(fromStart).toBe(6);

            const deltaHuge = 2000;
            const addHuge = Math.floor(deltaHuge / lineHeightPx);
            fromStart = Math.max(fromStart, Math.min(totalHidden, baseFromStart + addHuge));
            expect(fromStart).toBe(40);
        });

        it('scrubs upward for fromEnd when deltaY is negative', () => {
            const lineHeightPx = DEFAULT_LINE_HEIGHT_PX;
            let fromEnd = 0;
            const baseFromEnd = 0;

            const deltaY = -65;
            const addBelow = Math.floor(-deltaY / lineHeightPx);
            fromEnd = Math.max(fromEnd, baseFromEnd + addBelow);
            expect(fromEnd).toBe(3);

            const deltaMoveDown = -20;
            const addMoveDown = Math.floor(-deltaMoveDown / lineHeightPx);
            fromEnd = Math.max(fromEnd, baseFromEnd + addMoveDown);
            expect(fromEnd).toBe(3);
        });

        it('expands lines above fold when dragging down and below fold when dragging up in a single gesture', () => {
            const mockFileDiff = createMockFileDiff({
                name: 'test.cc',
                additionLines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`),
                deletionLines: Array.from({ length: 100 }, (_, i) => `old ${i + 1}`),
                hunks: [
                    createMockHunk({
                        collapsedBefore: 0,
                        additionStart: 1,
                        additionCount: 10,
                        deletionStart: 1,
                        deletionCount: 10,
                    }),
                    createMockHunk({
                        collapsedBefore: 30, // Gap: 30 lines (lines 11..40)
                        additionStart: 41,
                        additionCount: 10,
                        deletionStart: 41,
                        deletionCount: 10,
                    }),
                ],
            });

            let fromStart = 0;
            let fromEnd = 0;
            const host: HunkExpansionControllerHost = {
                getRenderedDiff: () => mockFileDiff,
                getExpandedHunk: () => ({ fromStart, fromEnd }),
                expandHunk: (_hunkIndex, direction, count = 0) => {
                    if (direction === 'up') {
                        fromStart += count;
                    }
                    if (direction === 'down') {
                        fromEnd += count;
                    }
                },
                getDiffStyle: () => 'split',
            };

            const listeners: Record<string, Array<EventListenerOrEventListenerObject>> = {};
            const mockWin = {
                addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                    listeners[type] = listeners[type] || [];
                    listeners[type].push(listener);
                },
                removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                    const list = listeners[type];
                    if (list) {
                        listeners[type] = list.filter((l) => l !== listener);
                    }
                },
            };

            const startEvent = {
                button: 0,
                clientY: 500,
                preventDefault: () => {},
                stopPropagation: () => {},
            };

            startSeamInteraction({
                event: startEvent,
                hunkIndex: 1,
                host,
                getLineHeightPx: () => 20,
                eventTarget: mockWin,
            });

            const dispatchMove = (clientY: number) => {
                const moveEvent = createMock<MouseEvent>({ clientY });
                listeners.pointermove?.forEach((listener) => {
                    if (typeof listener === 'function') {
                        listener(moveEvent);
                    } else if (listener && typeof listener === 'object') {
                        listener.handleEvent(moveEvent);
                    }
                });
            };

            const dispatchUp = (clientY: number) => {
                const upEvent = createMock<MouseEvent>({ clientY });
                listeners.pointerup?.forEach((listener) => {
                    if (typeof listener === 'function') {
                        listener(upEvent);
                    } else if (listener && typeof listener === 'object') {
                        listener.handleEvent(upEvent);
                    }
                });
            };

            // Drag down +160px (to clientY = 660): expands 8 lines above fold (fromStart: 8)
            dispatchMove(660);
            expect(fromStart).toBe(8);
            expect(fromEnd).toBe(0);

            // In the same gesture, drag back up -120px (to clientY = 540): expands 6 lines below fold (fromEnd: 6)
            dispatchMove(540);
            expect(fromStart).toBe(8);
            expect(fromEnd).toBe(6);

            // Release mouse
            dispatchUp(540);
        });

        it('drives monotonic downward and upward drag directly, verifying clamped lines and direction switching with decay', () => {
            const mockFileDiff = createMockFileDiff({
                name: 'test.cc',
                additionLines: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`),
                deletionLines: Array.from({ length: 100 }, (_, i) => `old ${i + 1}`),
                hunks: [
                    createMockHunk({
                        collapsedBefore: 0,
                        additionStart: 1,
                        additionCount: 10,
                        deletionStart: 1,
                        deletionCount: 10,
                    }),
                    createMockHunk({
                        collapsedBefore: 30, // Gap: 30 lines
                        additionStart: 41,
                        additionCount: 10,
                        deletionStart: 41,
                        deletionCount: 10,
                    }),
                ],
            });

            let fromStart = 0;
            let fromEnd = 0;
            const host: HunkExpansionControllerHost = {
                getRenderedDiff: () => mockFileDiff,
                getExpandedHunk: () => ({ fromStart, fromEnd }),
                expandHunk: (_hunkIndex, direction, count = 0) => {
                    if (direction === 'up') {
                        fromStart += count;
                    }
                    if (direction === 'down') {
                        fromEnd += count;
                    }
                },
                getDiffStyle: () => 'split',
            };

            const listeners: Record<string, Array<EventListenerOrEventListenerObject>> = {};
            const mockWin = {
                addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                    listeners[type] = listeners[type] || [];
                    listeners[type].push(listener);
                },
                removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
                    const list = listeners[type];
                    if (list) {
                        listeners[type] = list.filter((l) => l !== listener);
                    }
                },
            };

            const startEvent = {
                button: 0,
                clientY: 500,
                preventDefault: () => {},
                stopPropagation: () => {},
            };

            startSeamInteraction({
                event: startEvent,
                hunkIndex: 1,
                host,
                getLineHeightPx: () => 20,
                eventTarget: mockWin,
            });

            const dispatchMove = (clientY: number) => {
                const moveEvent = createMock<MouseEvent>({ clientY });
                listeners.pointermove?.forEach((listener) => {
                    if (typeof listener === 'function') {
                        listener(moveEvent);
                    } else if (listener && typeof listener === 'object') {
                        listener.handleEvent(moveEvent);
                    }
                });
            };

            const dispatchUp = (clientY: number) => {
                const upEvent = createMock<MouseEvent>({ clientY });
                listeners.pointerup?.forEach((listener) => {
                    if (typeof listener === 'function') {
                        listener(upEvent);
                    } else if (listener && typeof listener === 'object') {
                        listener.handleEvent(upEvent);
                    }
                });
            };

            // 1. Drag down +100px (5 lines)
            dispatchMove(600);
            expect(fromStart).toBe(5);
            expect(fromEnd).toBe(0);

            // 2. Jitter back up by 10px (to 590, less than 1 line height) - monotonic property holds:
            // fromStart stays at 5, fromEnd stays at 0 (no false expansions on minor jitters)
            dispatchMove(590);
            expect(fromStart).toBe(5);
            expect(fromEnd).toBe(0);

            // 3. Move up by 80px (to 510) - expands 4 lines below fold
            // The downward drag decays, direction switches to 'up', expanding fromEnd
            dispatchMove(510);
            expect(fromStart).toBe(5);
            expect(fromEnd).toBe(4);

            // 4. Release mouse
            dispatchUp(510);
        });
    });

    describe('HunkExpansionController & DOM Integration', () => {
        let cleanupDom: (() => void) | null = null;
        let makeEl: (tagName: string) => HTMLElement;

        beforeEach(() => {
            const { fakeDocument, makeElement } = createFakeDom();
            makeEl = makeElement;
            const originalDoc = globalThis.document;
            globalThis.document = fakeDocument;
            cleanupDom = () => {
                globalThis.document = originalDoc;
            };
        });

        afterEach(() => {
            if (cleanupDom) {
                cleanupDom();
                cleanupDom = null;
            }
        });

        it('renders custom seam bar with seam pills and no range tags', () => {
            const mockDiff = createMockFileDiff({
                name: 'example.ts',
                additionLines: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
                deletionLines: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
                hunks: [
                    createMockHunk({
                        collapsedBefore: 20,
                        additionStart: 21,
                        additionCount: 5,
                        deletionStart: 21,
                        deletionCount: 5,
                    }),
                ],
            });

            const host: HunkExpansionControllerHost = {
                getRenderedDiff: () => mockDiff,
                getExpandedHunk: () => ({ fromStart: 0, fromEnd: 0 }),
                expandHunk: () => {},
                getDiffStyle: () => 'unified',
            };

            const controller = new HunkExpansionController(host);
            const container = makeEl('div');
            const seamBar = controller.renderCustomSeamBar({
                container,
                hunkIndex: 0,
                diffStyle: 'unified',
                isDeletions: false,
                isAdditions: false,
                isUnified: true,
                gap: {
                    rangeSize: 20,
                    remaining: 20,
                    firstHiddenNew: 1,
                    lastHiddenNew: 20,
                    firstHiddenOld: 1,
                    lastHiddenOld: 20,
                    fromStart: 0,
                    fromEnd: 0,
                },
                targets: { above: null, below: null },
            });

            expect(seamBar).not.toBeNull();
            expect(seamBar.classList.contains('jj-hunk-seam')).toBe(true);
            expect(seamBar.querySelector('.seam-pill.pill-all')).not.toBeNull();
            expect(seamBar.textContent).toContain('+20 lines');
            expect(seamBar.querySelectorAll('.seam-gutter-tag').length).toBe(0);
        });

        it('wraps dock-pair inside ast-pill-anchor with unclipped ast-tooltip sibling and renders zero range tags', () => {
            const mockDiff = createMockFileDiff({
                name: 'example.ts',
                additionLines: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
                deletionLines: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
                hunks: [
                    createMockHunk({
                        collapsedBefore: 0,
                        additionStart: 1,
                        additionCount: 5,
                        deletionStart: 1,
                        deletionCount: 5,
                    }),
                    createMockHunk({
                        collapsedBefore: 20,
                        additionStart: 26,
                        additionCount: 5,
                        deletionStart: 26,
                        deletionCount: 5,
                    }),
                ],
            });

            const host: HunkExpansionControllerHost = {
                getRenderedDiff: () => mockDiff,
                getExpandedHunk: () => ({ fromStart: 0, fromEnd: 0 }),
                expandHunk: () => {},
                getDiffStyle: () => 'unified',
            };

            const controller = new HunkExpansionController(host);
            const container = makeEl('div');
            const targetBelow: AstBlockTarget = {
                block: {
                    name: 'testFuncBelow',
                    range: { start_line: 6, end_line: 25 },
                    children: [],
                },
                targetLine: 15,
                count: 10,
                refLine: 6,
                codePreview: 'function testFuncBelow() {',
                path: [{ name: 'testFuncBelow', range: { start_line: 6, end_line: 25 }, children: [] }],
            };

            const targetAbove: AstBlockTarget = {
                block: {
                    name: 'testFuncAbove',
                    range: { start_line: 26, end_line: 45 },
                    children: [],
                },
                targetLine: 35,
                count: 10,
                refLine: 45,
                codePreview: 'function testFuncAbove() {',
                path: [{ name: 'testFuncAbove', range: { start_line: 26, end_line: 45 }, children: [] }],
            };

            const seamBar = controller.renderCustomSeamBar({
                container,
                hunkIndex: 1,
                diffStyle: 'unified',
                isDeletions: false,
                isAdditions: false,
                isUnified: true,
                gap: {
                    rangeSize: 20,
                    remaining: 20,
                    firstHiddenNew: 6,
                    lastHiddenNew: 25,
                    firstHiddenOld: 6,
                    lastHiddenOld: 25,
                    fromStart: 0,
                    fromEnd: 0,
                },
                targets: { above: targetAbove, below: targetBelow },
            });

            // Zero .seam-gutter-tag elements rendered
            expect(seamBar.querySelectorAll('.seam-gutter-tag').length).toBe(0);

            // topDock is wrapped inside .dock-pair-group.ast-pill-anchor with unclipped tooltip-below
            const topDock = seamBar.querySelector<HTMLElement>('.dock-pair.dock-top');
            expect(topDock).not.toBeNull();
            const topGroup = topDock?.parentElement;
            expect(topGroup?.className).toBe('dock-pair-group ast-pill-anchor');
            const tooltipBelow = topGroup?.querySelector<HTMLElement>('.ast-tooltip.tooltip-below');
            expect(tooltipBelow).not.toBeNull();
            expect(topDock?.querySelector('.ast-tooltip')).toBeNull();
            expect(tooltipBelow?.parentElement).toBe(topGroup);
            expect(topDock?.querySelector('[data-role="step-down"]')).not.toBeNull();
            expect(topDock?.querySelector('[data-role="ast-down"]')).not.toBeNull();

            // bottomDock is wrapped inside .dock-pair-group.ast-pill-anchor with unclipped tooltip-above
            const bottomDock = seamBar.querySelector<HTMLElement>('.dock-pair.dock-bottom');
            expect(bottomDock).not.toBeNull();
            const bottomGroup = bottomDock?.parentElement;
            expect(bottomGroup?.className).toBe('dock-pair-group ast-pill-anchor');
            const tooltipAbove = bottomGroup?.querySelector<HTMLElement>('.ast-tooltip.tooltip-above');
            expect(tooltipAbove).not.toBeNull();
            expect(bottomDock?.querySelector('.ast-tooltip')).toBeNull();
            expect(tooltipAbove?.parentElement).toBe(bottomGroup);
            expect(bottomDock?.querySelector('[data-role="step-up"]')).not.toBeNull();
            expect(bottomDock?.querySelector('[data-role="ast-up"]')).not.toBeNull();
        });

        it('clears --diffs-column-number-width when enhanceCodeViewDiffItemSeparators is called with non-diff item', () => {
            const container = makeEl('div');
            container.style.setProperty('--diffs-column-number-width', '48px');
            expect(container.style.getPropertyValue('--diffs-column-number-width')).toBe('48px');

            enhanceCodeViewDiffItemSeparators(container, { type: 'file', name: 'image.png' });
            expect(container.style.getPropertyValue('--diffs-column-number-width')).toBe('');
        });

        it('enhances CodeView diff item separators via enhanceCodeViewDiffItemSeparators', () => {
            const container = makeEl('div');
            const content = makeEl('div');
            content.setAttribute('data-content', '');
            const sep = makeEl('div');
            sep.setAttribute('data-separator', 'line-info');
            sep.setAttribute('data-expand-index', '0');
            content.appendChild(sep);
            container.appendChild(content);

            const mockDiff = createMockFileDiff({
                name: 'item.ts',
                additionLines: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
                deletionLines: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`),
                hunks: [
                    createMockHunk({
                        collapsedBefore: 20,
                        additionStart: 21,
                        additionCount: 5,
                        deletionStart: 21,
                        deletionCount: 5,
                    }),
                ],
            });

            const diffItem = {
                type: 'diff',
                item: { fileDiff: mockDiff },
                instance: {
                    options: { diffStyle: 'unified' },
                    expandHunk: () => {},
                },
            };

            enhanceCodeViewDiffItemSeparators(container, diffItem);
            const seam = container.querySelector('.jj-hunk-seam');
            expect(seam).not.toBeNull();
            expect(seam?.textContent).toContain('+20 lines');
        });

        it('instantiates JjFileDiff cleanly and exposes controller helper methods', () => {
            const diff = new JjFileDiff({
                diffStyle: 'split',
            });
            expect(diff.hunkExpansionController).toBeInstanceOf(HunkExpansionController);
            expect(typeof diff.enhanceHunkSeparators).toBe('function');
            expect(typeof diff.resetForNewDiff).toBe('function');
            diff.cleanUp();
        });
    });

    describe('Python AST Grammar & Indentation Blocks', () => {
        describe('cleanBlockHeaderName', () => {
            it('formats Python functions and methods cleanly', () => {
                expect(cleanBlockHeaderName('def compute(x):')).toBe('compute()');
                expect(cleanBlockHeaderName('async def fetch_results(url: str):')).toBe('fetch_results()');
            });

            it('formats Python classes cleanly', () => {
                expect(cleanBlockHeaderName('class Worker(BaseWorker):')).toBe('Worker');
                expect(cleanBlockHeaderName('class Calculator:')).toBe('Calculator');
            });

            it('prioritizes Python control keywords before generic function matches', () => {
                expect(cleanBlockHeaderName('elif isinstance(x, int):')).toBe('elif (isinstance(x, int))');
                expect(cleanBlockHeaderName('with open("file.txt") as f:')).toBe('with (open("file.txt") as f)');
                expect(cleanBlockHeaderName('async with acquire_lock() as lock:')).toBe(
                    'async with (acquire_lock() as lock)',
                );
                expect(cleanBlockHeaderName('async with acquire_distributed_lock() as lock:')).toBe(
                    'async with (acquire_distributed_lo...)',
                );
                expect(cleanBlockHeaderName('except ValueError as e:')).toBe('except (ValueError as e)');
                expect(cleanBlockHeaderName('for item in get_items():')).toBe('for (item in get_items())');
                expect(cleanBlockHeaderName('async for msg in stream():')).toBe('async for (msg in stream())');
                expect(cleanBlockHeaderName('while is_running():')).toBe('while (is_running())');
            });

            it('formats parameterless Python blocks cleanly', () => {
                expect(cleanBlockHeaderName('try:')).toBe('try');
                expect(cleanBlockHeaderName('finally:')).toBe('finally');
                expect(cleanBlockHeaderName('else:')).toBe('else');
                expect(cleanBlockHeaderName('except:')).toBe('except');
            });

            it('formats else if statements cleanly', () => {
                expect(cleanBlockHeaderName('else if (status === 200) {')).toBe('else if (status === 200)');
                expect(cleanBlockHeaderName('else if (count > 0)')).toBe('else if (count > 0)');
            });

            it('formats match and case statements cleanly', () => {
                expect(cleanBlockHeaderName('match status:')).toBe('match (status)');
                expect(cleanBlockHeaderName('case 200:')).toBe('case (200)');
            });

            it('formats arrow function declarations cleanly', () => {
                expect(cleanBlockHeaderName('const handleClick = () => {')).toBe('handleClick()');
                expect(cleanBlockHeaderName('export const Card: React.FC<Props> = ({ title }) => {')).toBe('Card()');
                expect(cleanBlockHeaderName('let renderItem = async (item: Item) => {')).toBe('renderItem()');
                expect(cleanBlockHeaderName('onClick: () => {')).toBe('onClick()');
                expect(cleanBlockHeaderName('onClick={() => {')).toBe('onClick()');
            });

            it('formats method calls, chains, and JSX expressions cleanly', () => {
                expect(cleanBlockHeaderName('{items.map((item) => {')).toBe('items.map()');
                expect(cleanBlockHeaderName('items.map((x) => {')).toBe('items.map()');
                expect(cleanBlockHeaderName('const filtered = users.filter((u) => {')).toBe('users.filter()');
                expect(cleanBlockHeaderName('data.slice(0, 10).forEach((entry) => {')).toBe('data.slice()');
            });
        });

        describe('buildSyntaxBlocks with Python files', () => {
            it('correctly detects Python files containing dict literals, sets, and f-strings without fileName', () => {
                const pyLines = [
                    'class ConfigManager:', // L1
                    '    def get_config(self):', // L2
                    '        raw_data = {"key": "value", "count": 42}', // L3 - contains braces
                    '        options = {1, 2, 3}', // L4 - set literal with braces
                    '        if not raw_data:', // L5
                    '            msg = f"Empty data: {raw_data}"', // L6 - f-string with braces
                    '            return None', // L7
                    '        return raw_data', // L8
                ];
                const blocks = buildSyntaxBlocks(pyLines);
                expect(blocks.length).toBe(1);
                const cls = blocks[0];
                expect(cls.name).toBe('ConfigManager');
                expect(cls.range).toEqual({ start_line: 1, end_line: 8 });

                expect(cls.children.length).toBe(1);
                const fn = cls.children[0];
                expect(fn.name).toBe('get_config()');
                expect(fn.range).toEqual({ start_line: 2, end_line: 8 });

                expect(fn.children.length).toBe(1);
                const ifBlock = fn.children[0];
                expect(ifBlock.name).toBe('if (not raw_data)');
                expect(ifBlock.range).toEqual({ start_line: 5, end_line: 7 });
            });

            it('uses Python parser when fileName has .py or .star or .bzl extension', () => {
                const bzlLines = [
                    'def custom_rule(name, src):', // L1
                    '    if not name:', // L2
                    '        fail("Missing name")', // L3
                    '    return struct(name = name)', // L4
                ];
                const blocks = buildSyntaxBlocks(bzlLines, 'BUILD.bzl');
                expect(blocks.length).toBe(1);
                expect(blocks[0].name).toBe('custom_rule()');
                expect(blocks[0].range).toEqual({ start_line: 1, end_line: 4 });
                expect(blocks[0].children.length).toBe(1);
                expect(blocks[0].children[0].name).toBe('if (not name)');
            });

            it('handles multi-line signatures in Python functions', () => {
                const multiLineFn = [
                    'def process_items(', // L1
                    '    self,', // L2
                    '    items: list[str],', // L3
                    '    options: dict[str, int],', // L4
                    ') -> bool:', // L5
                    '    count = len(items)', // L6
                    '    if count > 0:', // L7
                    '        return True', // L8
                    '    return False', // L9
                ];
                const blocks = buildSyntaxBlocks(multiLineFn, 'processor.py');
                expect(blocks.length).toBe(1);
                const fn = blocks[0];
                expect(fn.name).toBe('process_items()');
                expect(fn.range.start_line).toBe(1);
                expect(fn.range.end_line).toBe(9);

                expect(fn.children.length).toBe(1);
                const ifBlock = fn.children[0];
                expect(ifBlock.name).toBe('if (count > 0)');
                expect(ifBlock.range).toEqual({ start_line: 7, end_line: 8 });
            });

            it('preserves block hierarchy across multi-line triple-quoted docstrings', () => {
                const pyWithDocstring = [
                    'class DataPipeline:', // L1
                    '    """A pipeline for processing records.', // L2
                    '    ', // L3
                    '    Example usage:', // L4
                    '        pipeline = DataPipeline()', // L5
                    '        pipeline.run()', // L6
                    '    """', // L7
                    '    def run(self):', // L8
                    '        """Execute pipeline stages."""', // L9
                    '        stage = 1', // L10
                    '        if stage == 1:', // L11
                    '            return True', // L12
                    '        return False', // L13
                ];
                const blocks = buildSyntaxBlocks(pyWithDocstring, 'pipeline.py');
                expect(blocks.length).toBe(1);
                const cls = blocks[0];
                expect(cls.name).toBe('DataPipeline');
                expect(cls.range).toEqual({ start_line: 1, end_line: 13 });

                expect(cls.children.length).toBe(1);
                const runFn = cls.children[0];
                expect(runFn.name).toBe('run()');
                expect(runFn.range).toEqual({ start_line: 8, end_line: 13 });

                expect(runFn.children.length).toBe(1);
                expect(runFn.children[0].name).toBe('if (stage == 1)');
                expect(runFn.children[0].range).toEqual({ start_line: 11, end_line: 12 });
            });

            it('progressively steps out from inner control blocks to function to class in Python', () => {
                const pyLines = [
                    'class TaskRunner:', // L1
                    '    def execute(self):', // L2
                    '        with open("log.txt") as f:', // L3
                    '            try:', // L4
                    '                raw = f.read()', // L5
                    '                data = raw.strip()', // L6
                    '            except Exception:', // L7
                    '                data = ""', // L8
                    '        return data', // L9
                ];
                const blocks = buildSyntaxBlocks(pyLines, 'runner.py');
                expect(blocks.length).toBe(1);
                const cls = blocks[0];
                expect(cls.name).toBe('TaskRunner');

                // Step-out verification on line 5 (inside try block)
                const pathAtL5 = findBlockTreePathForLine(5, blocks);
                const namesAtL5 = pathAtL5.map((b) => b.name);
                expect(namesAtL5).toEqual(['TaskRunner', 'execute()', 'with (open("log.txt") as f)', 'try']);

                // Step-out verification on line 6 (boundary of try, steps out to enclosing with block)
                const pathAtL6 = findBlockTreePathForLine(6, blocks);
                const namesAtL6 = pathAtL6.map((b) => b.name);
                expect(namesAtL6).toEqual(['TaskRunner', 'execute()', 'with (open("log.txt") as f)']);

                // Step-out verification on line 3 (inside execute, starting with block)
                const pathAtL3 = findBlockTreePathForLine(3, blocks);
                const namesAtL3 = pathAtL3.map((b) => b.name);
                expect(namesAtL3).toEqual(['TaskRunner', 'execute()']);

                // Step-out verification on line 2 (inside TaskRunner)
                const pathAtL2 = findBlockTreePathForLine(2, blocks);
                const namesAtL2 = pathAtL2.map((b) => b.name);
                expect(namesAtL2).toEqual(['TaskRunner']);
            });

            it('ignores single-line statements like "if not valid: return None" and preserves block scope', () => {
                const pyLines = [
                    'def validate_and_process(data):', // L1
                    '    if not data: return None', // L2 - single-line if, should not become a block
                    '    if len(data) > 0:', // L3 - multi-line if
                    '        count = len(data)', // L4
                    '        return count', // L5
                    '    return 0', // L6
                ];
                const blocks = buildSyntaxBlocks(pyLines, 'validator.py');
                expect(blocks.length).toBe(1);
                const fn = blocks[0];
                expect(fn.name).toBe('validate_and_process()');
                expect(fn.range).toEqual({ start_line: 1, end_line: 6 });

                expect(fn.children.length).toBe(1);
                expect(fn.children[0].name).toBe('if (len(data) > 0)');
                expect(fn.children[0].range).toEqual({ start_line: 3, end_line: 5 });
            });

            it('handles triple-quoted string closing with triple-quote followed by colon on same line', () => {
                const pyLines = [
                    'def transform(', // L1
                    '    prompt="""Multi-line prompt', // L2
                    '    with some text"""):', // L3 - triple quote closes here, followed by '):'
                    '    return prompt.strip()', // L4
                ];
                const blocks = buildSyntaxBlocks(pyLines, 'transform.py');
                expect(blocks.length).toBe(1);
                const fn = blocks[0];
                expect(fn.name).toBe('transform()');
                expect(fn.range).toEqual({ start_line: 1, end_line: 4 });
            });
        });
    });

    describe('adoptDiffCustomStyles', () => {
        let origCSSStyleSheet: unknown;

        class FakeCSSStyleSheet {
            css = '';
            replaceSync(text: string) {
                this.css = text;
            }
        }

        beforeEach(() => {
            origCSSStyleSheet = (globalThis as Record<string, unknown>).CSSStyleSheet;
            (globalThis as Record<string, unknown>).CSSStyleSheet = FakeCSSStyleSheet;
        });

        afterEach(() => {
            (globalThis as Record<string, unknown>).CSSStyleSheet = origCSSStyleSheet;
        });

        it('safely handles null and undefined roots', () => {
            expect(() => adoptDiffCustomStyles(null)).not.toThrow();
            expect(() => adoptDiffCustomStyles(undefined)).not.toThrow();
        });

        it('safely handles elements without shadowRoot', () => {
            const div = createMock<HTMLElement>({ shadowRoot: null });
            expect(() => adoptDiffCustomStyles(div)).not.toThrow();
        });

        it('adopts stylesheet on element with shadowRoot and is idempotent', () => {
            const adopted: CSSStyleSheet[] = [];
            const shadow = createMock<ShadowRoot>({
                nodeType: 11,
                host: createMock<Element>(),
                adoptedStyleSheets: adopted,
            });
            const host = createMock<HTMLElement>({ shadowRoot: shadow });
            adoptDiffCustomStyles(host);
            expect(shadow.adoptedStyleSheets.length).toBe(1);

            // Calling again must be idempotent
            adoptDiffCustomStyles(host);
            expect(shadow.adoptedStyleSheets.length).toBe(1);
        });

        it('adopts stylesheet directly on shadowRoot and is idempotent', () => {
            const adopted: CSSStyleSheet[] = [];
            const shadow = createMock<ShadowRoot>({
                nodeType: 11,
                host: createMock<Element>(),
                adoptedStyleSheets: adopted,
            });
            adoptDiffCustomStyles(shadow);
            expect(shadow.adoptedStyleSheets.length).toBe(1);

            // Calling again must be idempotent
            adoptDiffCustomStyles(shadow);
            expect(shadow.adoptedStyleSheets.length).toBe(1);
        });
    });

    describe('ensureThemeSelectionBackground', () => {
        it('populates default selection background when missing or empty', () => {
            const darkTheme = createMock<ThemeRegistration>({
                name: 'my-dark',
                type: 'dark',
                colors: {},
                settings: [],
            });
            ensureThemeSelectionBackground(darkTheme);
            expect(darkTheme.colors?.['editor.selectionBackground']).toBe('#69b1ff4d');

            const lightTheme = createMock<ThemeRegistration>({
                name: 'my-light',
                type: 'light',
                colors: {},
                settings: [],
            });
            ensureThemeSelectionBackground(lightTheme);
            expect(lightTheme.colors?.['editor.selectionBackground']).toBe('#009fff2e');
        });

        it('treats transparent and #0000 as missing', () => {
            const theme = createMock<ThemeRegistration>({
                name: 'trans',
                type: 'dark',
                colors: { 'editor.selectionBackground': 'transparent' },
                settings: [],
            });
            ensureThemeSelectionBackground(theme);
            expect(theme.colors?.['editor.selectionBackground']).toBe('#69b1ff4d');

            const theme2 = createMock<ThemeRegistration>({
                name: 'trans2',
                type: 'dark',
                colors: { 'editor.selectionBackground': '#00000000' },
                settings: [],
            });
            ensureThemeSelectionBackground(theme2);
            expect(theme2.colors?.['editor.selectionBackground']).toBe('#69b1ff4d');
        });

        it('converts opaque 6-digit hex to translucent hex', () => {
            const theme = createMock<ThemeRegistration>({
                name: 'opaque-dark',
                type: 'dark',
                colors: { 'editor.selectionBackground': '#44475a' },
                settings: [],
            });
            ensureThemeSelectionBackground(theme);
            expect(theme.colors?.['editor.selectionBackground']).toBe('#44475a4d');

            const lightTheme = createMock<ThemeRegistration>({
                name: 'opaque-light',
                type: 'light',
                colors: { 'editor.selectionBackground': '#e5e5e6' },
                settings: [],
            });
            ensureThemeSelectionBackground(lightTheme);
            expect(lightTheme.colors?.['editor.selectionBackground']).toBe('#e5e5e638');
        });

        it('converts opaque 3-digit hex to translucent hex', () => {
            const theme = createMock<ThemeRegistration>({
                name: 'short-dark',
                type: 'dark',
                colors: { 'editor.selectionBackground': '#abc' },
                settings: [],
            });
            ensureThemeSelectionBackground(theme);
            expect(theme.colors?.['editor.selectionBackground']).toBe('#aabbcc4d');
        });

        it('replaces opaque ff alpha with translucent alpha', () => {
            const theme = createMock<ThemeRegistration>({
                name: 'ff-dark',
                type: 'dark',
                colors: { 'editor.selectionBackground': '#112233ff' },
                settings: [],
            });
            ensureThemeSelectionBackground(theme);
            expect(theme.colors?.['editor.selectionBackground']).toBe('#1122334d');
        });
    });

    describe('XML, HTML, SVG, Svelte/Vue, and React (JSX/TSX) Syntax Blocks', () => {
        describe('mergeSyntaxBlockTrees', () => {
            it('merges flat and nested blocks with interval containment and prefers JSX tags over generic braces', () => {
                const braceBlocks: SyntaxBlock[] = [
                    {
                        name: 'App()',
                        range: { start_line: 1, end_line: 20 },
                        children: [
                            {
                                name: '{...}',
                                range: { start_line: 5, end_line: 15 },
                                children: [],
                            },
                        ],
                    },
                ];
                const tagBlocks: SyntaxBlock[] = [
                    {
                        name: '<div.container>',
                        range: { start_line: 5, end_line: 15 },
                        children: [
                            {
                                name: '<button>',
                                range: { start_line: 8, end_line: 12 },
                                children: [],
                            },
                        ],
                    },
                ];
                const merged = mergeSyntaxBlockTrees(braceBlocks, tagBlocks);
                expect(merged.length).toBe(1);
                expect(merged[0].name).toBe('App()');
                expect(merged[0].children.length).toBe(1);
                expect(merged[0].children[0].name).toBe('<div.container>');
                expect(merged[0].children[0].children.length).toBe(1);
                expect(merged[0].children[0].children[0].name).toBe('<button>');
            });

            it('returns empty array when both inputs are empty', () => {
                expect(mergeSyntaxBlockTrees([], [])).toEqual([]);
            });
        });

        describe('formatXmlHtmlBlockName', () => {
            it('formats React shorthand fragment', () => {
                expect(formatXmlHtmlBlockName('<>')).toBe('<>');
                expect(formatXmlHtmlBlockName('< >')).toBe('<>');
            });

            it('formats element with ID taking precedence over class', () => {
                expect(formatXmlHtmlBlockName('<div id="hero" class="container">')).toBe('<div#hero>');
                expect(formatXmlHtmlBlockName("<section id='main-section'>")).toBe('<section#main-section>');
            });

            it('formats element with class or className', () => {
                expect(formatXmlHtmlBlockName('<div className="card shadow-lg">')).toBe('<div.card>');
                expect(formatXmlHtmlBlockName("<div class='btn btn-primary'>")).toBe('<div.btn>');
                expect(formatXmlHtmlBlockName('<aside class=sidebar>')).toBe('<aside.sidebar>');
            });

            it('formats Svelte class directive', () => {
                expect(formatXmlHtmlBlockName('<div class:active={isActive}>')).toBe('<div.active>');
            });

            it('formats Android resource IDs cleanly', () => {
                expect(formatXmlHtmlBlockName('<LinearLayout android:id="@+id/main_layout">')).toBe(
                    '<LinearLayout#main_layout>',
                );
            });

            it('formats dotted component names in React', () => {
                expect(formatXmlHtmlBlockName('<React.Fragment>')).toBe('<React.Fragment>');
                expect(formatXmlHtmlBlockName('<Modal.Body className="p-4">')).toBe('<Modal.Body.p-4>');
            });

            it('truncates formatted names exceeding 28 characters cleanly with ...>', () => {
                const longTag = '<div className="very-long-class-name-that-is-way-too-long">';
                const formatted = formatXmlHtmlBlockName(longTag);
                expect(formatted.length).toBeLessThanOrEqual(28);
                expect(formatted).toBe('<div.very-long-class-nam...>');
            });
        });

        describe('parseXmlHtmlSyntaxBlocks for HTML', () => {
            it('parses nested HTML elements and ignores void elements', () => {
                const htmlLines = [
                    '<!DOCTYPE html>', // L1
                    '<html>', // L2
                    '  <head>', // L3
                    '    <meta charset="utf-8">', // L4 (void)
                    '    <title>Test Page</title>', // L5
                    '  </head>', // L6
                    '  <body>', // L7
                    '    <div id="app" class="wrapper">', // L8
                    '      <img src="logo.png" alt="logo">', // L9 (void)
                    '      <p class="intro">', // L10
                    '        Hello World', // L11
                    '      </p>', // L12
                    '    </div>', // L13
                    '  </body>', // L14
                    '</html>', // L15
                ];
                const blocks = parseXmlHtmlSyntaxBlocks(htmlLines, 'index.html');
                expect(blocks.length).toBe(1);
                const htmlBlock = blocks[0];
                expect(htmlBlock.name).toBe('<html>');
                expect(htmlBlock.range).toEqual({ start_line: 2, end_line: 15 });

                expect(htmlBlock.children.length).toBe(2);
                const [headBlock, bodyBlock] = htmlBlock.children;
                expect(headBlock.name).toBe('<head>');
                expect(headBlock.range).toEqual({ start_line: 3, end_line: 6 });

                expect(bodyBlock.name).toBe('<body>');
                expect(bodyBlock.range).toEqual({ start_line: 7, end_line: 14 });

                expect(bodyBlock.children.length).toBe(1);
                const appBlock = bodyBlock.children[0];
                expect(appBlock.name).toBe('<div#app>');
                expect(appBlock.range).toEqual({ start_line: 8, end_line: 13 });

                expect(appBlock.children.length).toBe(1);
                const pBlock = appBlock.children[0];
                expect(pBlock.name).toBe('<p.intro>');
                expect(pBlock.range).toEqual({ start_line: 10, end_line: 12 });
            });

            it('skips multi-line comments and CDATA sections', () => {
                const htmlLines = [
                    '<main>', // L1
                    '  <!--', // L2
                    '    <div class="ignore-me">', // L3
                    '      Unclosed comment content', // L4
                    '    </div>', // L5
                    '  -->', // L6
                    '  <section class="content">', // L7
                    '    <![CDATA[ <not-a-tag> inside cdata ]]>', // L8
                    '    <p>Actual content</p>', // L9
                    '  </section>', // L10
                    '</main>', // L11
                ];
                const blocks = parseXmlHtmlSyntaxBlocks(htmlLines, 'page.html');
                expect(blocks.length).toBe(1);
                const mainBlock = blocks[0];
                expect(mainBlock.name).toBe('<main>');
                expect(mainBlock.children.length).toBe(1);
                const secBlock = mainBlock.children[0];
                expect(secBlock.name).toBe('<section.content>');
                expect(secBlock.range).toEqual({ start_line: 7, end_line: 10 });
            });

            it('handles multi-line opening tags with attributes across lines', () => {
                const htmlLines = [
                    '<div', // L1
                    '  id="main-container"', // L2
                    '  class="container fluid"', // L3
                    '  data-test="hero"', // L4
                    '>', // L5
                    '  <span>Inside</span>', // L6
                    '</div>', // L7
                ];
                const blocks = parseXmlHtmlSyntaxBlocks(htmlLines, 'index.html');
                expect(blocks.length).toBe(1);
                expect(blocks[0].name).toBe('<div#main-container>');
                expect(blocks[0].range).toEqual({ start_line: 1, end_line: 7 });
            });

            it('parses embedded <script> with JS functions and <style> with CSS rules as child blocks', () => {
                const htmlLines = [
                    '<html>', // L1
                    '  <head>', // L2
                    '    <style>', // L3
                    '      .card {', // L4
                    '        padding: 16px;', // L5
                    '      }', // L6
                    '    </style>', // L7
                    '  </head>', // L8
                    '  <body>', // L9
                    '    <script>', // L10
                    '      function initializeApp() {', // L11
                    '        if (ready) {', // L12
                    '          console.log("ready");', // L13
                    '        }', // L14
                    '      }', // L15
                    '    </script>', // L16
                    '  </body>', // L17
                    '</html>', // L18
                ];
                const blocks = parseXmlHtmlSyntaxBlocks(htmlLines, 'app.html');
                expect(blocks.length).toBe(1);
                const htmlBlock = blocks[0];
                const [headBlock, bodyBlock] = htmlBlock.children;

                const styleBlock = headBlock.children[0];
                expect(styleBlock.name).toBe('<style>');
                expect(styleBlock.range).toEqual({ start_line: 3, end_line: 7 });
                expect(styleBlock.children.length).toBe(1);
                expect(styleBlock.children[0].name).toBe('.card');
                expect(styleBlock.children[0].range).toEqual({ start_line: 4, end_line: 6 });

                const scriptBlock = bodyBlock.children[0];
                expect(scriptBlock.name).toBe('<script>');
                expect(scriptBlock.range).toEqual({ start_line: 10, end_line: 16 });
                expect(scriptBlock.children.length).toBe(1);
                const fnBlock = scriptBlock.children[0];
                expect(fnBlock.name).toBe('initializeApp()');
                expect(fnBlock.range).toEqual({ start_line: 11, end_line: 15 });
                expect(fnBlock.children.length).toBe(1);
                expect(fnBlock.children[0].name).toBe('if (ready)');
                expect(fnBlock.children[0].range).toEqual({ start_line: 12, end_line: 14 });
            });
        });

        describe('parseXmlHtmlSyntaxBlocks for XML & SVG', () => {
            it('parses SVG with nested <g> and self-closing tags', () => {
                const svgLines = [
                    '<?xml version="1.0" encoding="utf-8"?>', // L1
                    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">', // L2
                    '  <g id="layer-bg" class="background">', // L3
                    '    <rect width="100" height="100" fill="#fff" />', // L4 (self-closing)
                    '    <circle cx="50" cy="50" r="40" />', // L5 (self-closing)
                    '  </g>', // L6
                    '  <g id="layer-fg">', // L7
                    '    <path d="M 10 10 L 90 90" />', // L8
                    '  </g>', // L9
                    '</svg>', // L10
                ];
                const blocks = parseXmlHtmlSyntaxBlocks(svgLines, 'graphic.svg');
                expect(blocks.length).toBe(1);
                const svgBlock = blocks[0];
                expect(svgBlock.name).toBe('<svg>');
                expect(svgBlock.range).toEqual({ start_line: 2, end_line: 10 });
                expect(svgBlock.children.length).toBe(2);
                expect(svgBlock.children[0].name).toBe('<g#layer-bg>');
                expect(svgBlock.children[0].range).toEqual({ start_line: 3, end_line: 6 });
                expect(svgBlock.children[1].name).toBe('<g#layer-fg>');
                expect(svgBlock.children[1].range).toEqual({ start_line: 7, end_line: 9 });
            });

            it('treats <link> as container element in XML (not HTML void element)', () => {
                const rssLines = [
                    '<rss version="2.0">', // L1
                    '  <channel>', // L2
                    '    <title>Blog Feed</title>', // L3
                    '    <link>', // L4
                    '      https://example.com/rss-feed', // L5
                    '    </link>', // L6
                    '  </channel>', // L7
                    '</rss>', // L8
                ];
                const blocks = parseXmlHtmlSyntaxBlocks(rssLines, 'feed.rss');
                expect(blocks.length).toBe(1);
                const rssBlock = blocks[0];
                const channelBlock = rssBlock.children[0];
                expect(channelBlock.name).toBe('<channel>');
                expect(channelBlock.children.length).toBe(1);
                const linkBlock = channelBlock.children[0];
                expect(linkBlock.name).toBe('<link>');
                expect(linkBlock.range).toEqual({ start_line: 4, end_line: 6 });
            });
        });

        describe('Svelte and Vue SFCs', () => {
            it('parses Svelte component with script, template tags, and style', () => {
                const svelteLines = [
                    '<script lang="ts">', // L1
                    '  let count = 0;', // L2
                    '  function increment() {', // L3
                    '    count += 1;', // L4
                    '  }', // L5
                    '</script>', // L6
                    '', // L7
                    '<main class="counter-container">', // L8
                    '  <button on:click={increment}>', // L9
                    '    Clicks: {count}', // L10
                    '  </button>', // L11
                    '</main>', // L12
                    '', // L13
                    '<style>', // L14
                    '  button {', // L15
                    '    color: blue;', // L16
                    '  }', // L17
                    '</style>', // L18
                ];
                const blocks = buildSyntaxBlocks(svelteLines, 'Counter.svelte');
                expect(blocks.length).toBe(3);

                const scriptBlock = blocks[0];
                expect(scriptBlock.name).toBe('<script>');
                expect(scriptBlock.range).toEqual({ start_line: 1, end_line: 6 });
                expect(scriptBlock.children.length).toBe(1);
                expect(scriptBlock.children[0].name).toBe('increment()');

                const mainBlock = blocks[1];
                expect(mainBlock.name).toBe('<main.counter-container>');
                expect(mainBlock.range).toEqual({ start_line: 8, end_line: 12 });
                expect(mainBlock.children.length).toBe(1);
                expect(mainBlock.children[0].name).toBe('<button>');
                expect(mainBlock.children[0].range).toEqual({ start_line: 9, end_line: 11 });

                const styleBlock = blocks[2];
                expect(styleBlock.name).toBe('<style>');
                expect(styleBlock.range).toEqual({ start_line: 14, end_line: 18 });
                expect(styleBlock.children.length).toBe(1);
                expect(styleBlock.children[0].name).toBe('button');
            });
        });

        describe('React JSX and TSX Tag Block Expansion', () => {
            it('guards against TypeScript generics and comparison operators', () => {
                const tsxLines = [
                    'export function DataViewer<T extends object>() {', // L1
                    '  const [items, setItems] = useState<string[]>([]);', // L2
                    '  const ref = useRef<HTMLDivElement | null>(null);', // L3
                    '  if (items.length < 5) {', // L4
                    '    return <p>Loading</p>;', // L5
                    '  }', // L6
                    '  return (', // L7
                    '    <div className="viewer-grid">', // L8
                    '      <span>Item</span>', // L9
                    '    </div>', // L10
                    '  );', // L11
                    '}', // L12
                ];
                const blocks = buildSyntaxBlocks(tsxLines, 'DataViewer.tsx');
                expect(blocks.length).toBe(1);
                const fnBlock = blocks[0];
                expect(fnBlock.name).toBe('DataViewer()');
                expect(fnBlock.range).toEqual({ start_line: 1, end_line: 12 });

                expect(fnBlock.children.length).toBe(2);
                expect(fnBlock.children[0].name).toBe('if (items.length < 5)');
                expect(fnBlock.children[0].range).toEqual({ start_line: 4, end_line: 6 });

                expect(fnBlock.children[1].name).toBe('<div.viewer-grid>');
                expect(fnBlock.children[1].range).toEqual({ start_line: 8, end_line: 10 });
            });

            it('supports React shorthand fragments <>...</> in JSX', () => {
                const jsxLines = [
                    'function PageHeader() {', // L1
                    '  return (', // L2
                    '    <>', // L3
                    '      <nav className="navbar">', // L4
                    '        <a href="/">Home</a>', // L5
                    '      </nav>', // L6
                    '      <div className="hero-banner">', // L7
                    '        <h1>Welcome</h1>', // L8
                    '      </div>', // L9
                    '    </>', // L10
                    '  );', // L11
                    '}', // L12
                ];
                const blocks = buildSyntaxBlocks(jsxLines, 'Header.jsx');
                expect(blocks.length).toBe(1);
                const fnBlock = blocks[0];
                expect(fnBlock.name).toBe('PageHeader()');

                expect(fnBlock.children.length).toBe(1);
                const fragBlock = fnBlock.children[0];
                expect(fragBlock.name).toBe('<>');
                expect(fragBlock.range).toEqual({ start_line: 3, end_line: 10 });

                expect(fragBlock.children.length).toBe(2);
                expect(fragBlock.children[0].name).toBe('<nav.navbar>');
                expect(fragBlock.children[0].range).toEqual({ start_line: 4, end_line: 6 });
                expect(fragBlock.children[1].name).toBe('<div.hero-banner>');
                expect(fragBlock.children[1].range).toEqual({ start_line: 7, end_line: 9 });
            });

            it('merges JS functions, method chains, and JSX elements in proper hierarchy and steps out progressively', () => {
                const tsxLines = [
                    'export const UserDirectory = ({ orgId }: Props) => {', // L1
                    '  const [users, setUsers] = useState<User[]>([]);', // L2
                    '  return (', // L3
                    '    <div id="directory" className="directory-view">', // L4
                    '      <header className="header-bar">', // L5
                    '        <h2>Staff</h2>', // L6
                    '      </header>', // L7
                    '      <ul className="user-list">', // L8
                    '        {users.map((user) => {', // L9
                    '          return (', // L10
                    '            <li key={user.id} className="user-card">', // L11
                    '              <span className="name">{user.name}</span>', // L12
                    '              <button onClick={() => alert(user.id)}>View</button>', // L13
                    '            </li>', // L14
                    '          );', // L15
                    '        })}', // L16
                    '      </ul>', // L17
                    '    </div>', // L18
                    '  );', // L19
                    '};', // L20
                ];
                const blocks = buildSyntaxBlocks(tsxLines, 'UserDirectory.tsx');
                expect(blocks.length).toBe(1);
                const compBlock = blocks[0];
                expect(compBlock.name).toBe('UserDirectory()');
                expect(compBlock.range).toEqual({ start_line: 1, end_line: 20 });

                expect(compBlock.children.length).toBe(1);
                const divBlock = compBlock.children[0];
                expect(divBlock.name).toBe('<div#directory>');
                expect(divBlock.range).toEqual({ start_line: 4, end_line: 18 });

                expect(divBlock.children.length).toBe(2);
                const headerBlock = divBlock.children[0];
                expect(headerBlock.name).toBe('<header.header-bar>');
                expect(headerBlock.range).toEqual({ start_line: 5, end_line: 7 });

                const ulBlock = divBlock.children[1];
                expect(ulBlock.name).toBe('<ul.user-list>');
                expect(ulBlock.range).toEqual({ start_line: 8, end_line: 17 });

                expect(ulBlock.children.length).toBe(1);
                const mapBlock = ulBlock.children[0];
                expect(mapBlock.name).toBe('users.map()');
                expect(mapBlock.range).toEqual({ start_line: 9, end_line: 16 });

                expect(mapBlock.children.length).toBe(1);
                const liBlock = mapBlock.children[0];
                expect(liBlock.name).toBe('<li.user-card>');
                expect(liBlock.range).toEqual({ start_line: 11, end_line: 14 });

                // Progressive AST step-out from line 12:
                const pathAtL12 = findBlockTreePathForLine(12, blocks);
                const namesAtL12 = pathAtL12.map((b) => b.name);
                expect(namesAtL12).toEqual([
                    'UserDirectory()',
                    '<div#directory>',
                    '<ul.user-list>',
                    'users.map()',
                    '<li.user-card>',
                ]);

                // Boundary of <li.user-card> (line 14) steps out to enclosing users.map():
                const pathAtL14 = findBlockTreePathForLine(14, blocks);
                const namesAtL14 = pathAtL14.map((b) => b.name);
                expect(namesAtL14).toEqual(['UserDirectory()', '<div#directory>', '<ul.user-list>', 'users.map()']);
            });

            it('auto-detects XML and JSX content without fileName', () => {
                const xmlLines = [
                    '<?xml version="1.0"?>',
                    '<root>',
                    '  <child id="1">',
                    '    Content',
                    '  </child>',
                    '</root>',
                ];
                const xmlBlocks = buildSyntaxBlocks(xmlLines);
                expect(xmlBlocks.length).toBe(1);
                expect(xmlBlocks[0].name).toBe('<root>');
                expect(xmlBlocks[0].children[0].name).toBe('<child#1>');

                const jsxLines = [
                    'const App = () => {',
                    '  return (',
                    '    <main className="app-shell">',
                    '      <section>Body</section>',
                    '    </main>',
                    '  );',
                    '};',
                ];
                const jsxBlocks = buildSyntaxBlocks(jsxLines);
                expect(jsxBlocks.length).toBe(1);
                expect(jsxBlocks[0].name).toBe('App()');
                expect(jsxBlocks[0].children.length).toBe(1);
                expect(jsxBlocks[0].children[0].name).toBe('<main.app-shell>');
            });

            it('enforces raw-text mode inside <script> and <style> ignoring nested comparisons and HTML strings', () => {
                const svelteLines = [
                    '<script lang="ts">', // L1
                    '  function compute(a: number, count: number, b: number) {', // L2
                    '    if (a < count && b > 0) {', // L3
                    '      const tpl = "<div>\\n</div>";', // L4
                    '      return tpl;', // L5
                    '    }', // L6
                    '  }', // L7
                    '</script>', // L8
                    '',
                    '<main class="container">', // L10
                    '  <p>Hello</p>', // L11
                    '</main>', // L12
                ];
                const blocks = buildSyntaxBlocks(svelteLines, 'App.svelte');
                expect(blocks.length).toBe(2);
                expect(blocks[0].name).toBe('<script>');
                expect(blocks[0].range).toEqual({ start_line: 1, end_line: 8 });
                // Check internal brace blocks: compute() and if (a < count...)
                expect(blocks[0].children.length).toBe(1);
                expect(blocks[0].children[0].name).toBe('compute()');
                expect(blocks[0].children[0].children.length).toBe(1);
                expect(blocks[0].children[0].children[0].name).toBe('if (a < count && b > 0)');

                expect(blocks[1].name).toBe('<main.container>');
                expect(blocks[1].range).toEqual({ start_line: 10, end_line: 12 });
            });

            it('tracks quotes at all brace depths inside multi-line JSX tags', () => {
                const lines = [
                    'export const Button = () => {', // L1
                    '  return (', // L2
                    '    <button', // L3
                    '      type="button"', // L4
                    '      className="btn primary"', // L5
                    '      onClick={() => alert("}") && a > b}', // L6
                    '    >', // L7
                    '      <span>', // L8
                    '        Click Me', // L9
                    '      </span>', // L10
                    '    </button>', // L11
                    '  );', // L12
                    '};', // L13
                ];
                const blocks = buildSyntaxBlocks(lines, 'Button.tsx');
                expect(blocks.length).toBe(1);
                expect(blocks[0].name).toBe('Button()');
                const btnBlock = blocks[0].children[0];
                expect(btnBlock.name).toBe('<button.btn>');
                expect(btnBlock.range).toEqual({ start_line: 3, end_line: 11 });
                expect(btnBlock.children[0].name).toBe('<span>');
                expect(btnBlock.children[0].range).toEqual({ start_line: 8, end_line: 10 });
            });

            it('preserves PascalCase components and does not treat them as HTML void elements', () => {
                const lines = [
                    'export const Nav = () => {', // L1
                    '  return (', // L2
                    '    <nav className="navbar">', // L3
                    '      <Link to="/home">', // L4
                    '        <span>Home</span>', // L5
                    '      </Link>', // L6
                    '      <Input placeholder="Search">', // L7
                    '        <kbd>Ctrl+K</kbd>', // L8
                    '      </Input>', // L9
                    '      <input type="text" />', // L10 (void element)
                    '    </nav>', // L11
                    '  );', // L12
                    '};', // L13
                ];
                const blocks = buildSyntaxBlocks(lines, 'Nav.tsx');
                expect(blocks.length).toBe(1);
                const navBlock = blocks[0].children[0];
                expect(navBlock.name).toBe('<nav.navbar>');
                expect(navBlock.children.length).toBe(2);
                expect(navBlock.children[0].name).toBe('<Link>');
                expect(navBlock.children[0].range).toEqual({ start_line: 4, end_line: 6 });
                expect(navBlock.children[1].name).toBe('<Input>');
                expect(navBlock.children[1].range).toEqual({ start_line: 7, end_line: 9 });
            });

            it('guards TypeScript generic arrow functions and does not emit <T> tags', () => {
                const lines = [
                    'export const List = <T extends { id: string }>(props: Props<T>) => {', // L1
                    '  const lt = a < b;', // L2
                    '  return (', // L3
                    '    <div className="list-wrapper">', // L4
                    '      <ul>', // L5
                    '        {props.items.map((item) => (', // L6
                    '          <li key={item.id}>', // L7
                    '            {item.id}', // L8
                    '          </li>', // L9
                    '        ))}', // L10
                    '      </ul>', // L11
                    '    </div>', // L12
                    '  );', // L13
                    '};', // L14
                ];
                const blocks = buildSyntaxBlocks(lines, 'List.tsx');
                expect(blocks.length).toBe(1);
                expect(blocks[0].name).toBe('List()');
                expect(blocks[0].range).toEqual({ start_line: 1, end_line: 14 });
                // Should not contain any block named '<T>'
                const allNames = flattenSyntaxBlocks(blocks).map((b) => b.name);
                expect(allNames).not.toContain('<T>');
                expect(allNames).toContain('<div.list-wrapper>');
                expect(allNames).toContain('<ul>');
                expect(allNames).toContain('<li>');
            });

            it('formats XML/HTML block names cleanly with case-insensitivity and quoted-attribute matching', () => {
                // Should ignore ?id=42 inside href and unquoted expressions
                expect(formatXmlHtmlBlockName('<a href="/item?id=42" className={styles.btn}>')).toBe('<a>');
                // Should match case-insensitive ID and className
                expect(formatXmlHtmlBlockName('<DIV ID="Main-Content" ClassName="hero banner">')).toBe(
                    '<DIV#Main-Content>',
                );
                expect(formatXmlHtmlBlockName('<section CLASS="hero-section">')).toBe('<section.hero-section>');
                // Should handle Android resource IDs
                expect(formatXmlHtmlBlockName('<TextView android:id="@+id/title_text" />')).toBe(
                    '<TextView#title_text>',
                );
            });

            it('parses Vue single-file components (.vue)', () => {
                const vueLines = [
                    '<template>', // L1
                    '  <div id="app" class="vue-container">', // L2
                    '    <header.nav-bar>', // L3 (dotted component)
                    '      <h1>Title</h1>', // L4
                    '    </header.nav-bar>', // L5
                    '  </div>', // L6
                    '</template>', // L7
                    '',
                    '<script setup lang="ts">', // L9
                    'import { ref } from "vue";', // L10
                    'const count = ref(0);', // L11
                    'function increment() {', // L12
                    '  count.value++;', // L13
                    '}', // L14
                    '</script>', // L15
                    '',
                    '<style scoped>', // L17
                    '.vue-container {', // L18
                    '  padding: 1rem;', // L19
                    '}', // L20
                    '</style>', // L21
                ];
                const blocks = buildSyntaxBlocks(vueLines, 'App.vue');
                expect(blocks.length).toBe(3);
                expect(blocks[0].name).toBe('<template>');
                expect(blocks[0].children[0].name).toBe('<div#app>');
                expect(blocks[0].children[0].children[0].name).toBe('<header.nav-bar>');

                expect(blocks[1].name).toBe('<script>');
                expect(blocks[1].children.length).toBe(1);
                expect(blocks[1].children[0].name).toBe('increment()');

                expect(blocks[2].name).toBe('<style>');
                expect(blocks[2].children.length).toBe(1);
                expect(blocks[2].children[0].name).toBe('.vue-container');
            });

            it('enforces strict upper-bound containment in mergeSyntaxBlockTrees for overlapping intervals', () => {
                // Two blocks where B starts inside A but ends after A (overhang):
                // A: [10, 20]
                // B: [15, 25]
                // B must NOT be attached as a child of A!
                const blockA: SyntaxBlock = {
                    name: 'BlockA',
                    range: { start_line: 10, end_line: 20 },
                    children: [],
                };
                const blockB: SyntaxBlock = {
                    name: 'BlockB',
                    range: { start_line: 15, end_line: 25 },
                    children: [],
                };
                const merged = mergeSyntaxBlockTrees([blockA], [blockB]);
                expect(merged.length).toBe(2);
                expect(merged[0].name).toBe('BlockA');
                expect(merged[0].children.length).toBe(0);
                expect(merged[1].name).toBe('BlockB');
                expect(merged[1].children.length).toBe(0);
            });

            it('recovers from mismatched inner tags and handles multi-line DOCTYPE and XML processing instructions', () => {
                const xmlLines = [
                    '<?xml version="1.0"', // L1
                    '      encoding="UTF-8"?>', // L2
                    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"', // L3
                    '          "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">', // L4
                    '<html xmlns="http://www.w3.org/1999/xhtml">', // L5
                    '  <body>', // L6
                    '    <p>', // L7
                    '      <span>Text', // L8 (unclosed span)
                    '    </p>', // L9 (closes p, popping span gracefully)
                    '  </body>', // L10
                    '</html>', // L11
                ];
                const blocks = parseXmlHtmlSyntaxBlocks(xmlLines, 'document.xhtml');
                expect(blocks.length).toBe(1);
                expect(blocks[0].name).toBe('<html>');
                expect(blocks[0].children.length).toBe(1);
                const bodyBlock = blocks[0].children[0];
                expect(bodyBlock.name).toBe('<body>');
                expect(bodyBlock.children.length).toBe(1);
                expect(bodyBlock.children[0].name).toBe('<p>');
                expect(bodyBlock.children[0].range).toEqual({ start_line: 7, end_line: 9 });
            });

            it('builds syntax blocks directly from FileDiffMetadata via buildSyntaxBlocksFromDiff', () => {
                const diff = createMock<FileDiffMetadata>({
                    name: 'Component.tsx',
                    additionLines: [
                        'export function Component() {',
                        '  return (',
                        '    <div id="root">',
                        '      <span>Hello</span>',
                        '    </div>',
                        '  );',
                        '}',
                    ],
                });
                const blocks = buildSyntaxBlocksFromDiff(diff);
                expect(blocks.length).toBe(1);
                expect(blocks[0].name).toBe('Component()');
                expect(blocks[0].children[0].name).toBe('<div#root>');
            });
        });
    });
});
