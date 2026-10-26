/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SelectedLineRange } from '@pierre/diffs';
import { getFsPathFromUri, getRevisionFromUri, type Uri } from '../../../src/core/uri-utils';
import type { MultiDiffFileEntry } from '../tabs/tab-types';

export interface EditorChatContextSelection {
    /** Display filename (cleaned of trailing revision suffix). */
    filename: string;
    /** Optional workspace/filesystem path or URI path if available. */
    fsPath?: string;
    /** Optional revision label (e.g. '@', short change_id). */
    revision?: string;
    /** 1-based inclusive start line number, if known. */
    startLine?: number;
    /** 1-based inclusive end line number, if known. */
    endLine?: number;
    /** Whether the selection came from the deletions (original) or additions (modified) side. */
    side?: 'deletions' | 'additions';
    /** The selected code/text snippet. */
    selectedText: string;
}

export interface PierreEditorSelectionPosition {
    line: number;
    character: number;
}

export interface PierreEditorSelectionRange {
    start: PierreEditorSelectionPosition;
    end: PierreEditorSelectionPosition;
}

export interface PierreEditorEditStateLike {
    document: {
        getText: (range?: PierreEditorSelectionRange) => string;
    };
    editor: {
        activeBuffer?: 'deletions' | 'additions' | 'files';
        selections?: PierreEditorSelectionRange[];
    };
}

export interface PierreEditorLike {
    getEditState: () => PierreEditorEditStateLike | undefined;
}

export interface PierreCodeViewLike {
    getSelectedLines: () => { id: string; range: SelectedLineRange } | null;
    getRenderedItems: () => readonly { id: string; container: HTMLElement }[];
}

export interface DomExtractedSelection {
    selectedText: string;
    startLine?: number;
    endLine?: number;
    side?: 'deletions' | 'additions';
    diffsContainer?: Element;
}

interface ShadowRootWithSelection extends ShadowRoot {
    getSelection?: () => Selection | null;
}

/**
 * Strips trailing revision annotation suffixes like ` (abcd1234)` from viewer titles.
 */
export function cleanViewerFilename(raw: string): string {
    return raw.replace(/\s*\([^)]*\)$/, '').trim();
}

/**
 * Extracts a short revision label from a resource URI or viewer title suffix.
 */
export function extractViewerRevision(
    filename: string,
    resourceUri?: Uri,
    isWorkingCopy?: boolean,
): string | undefined {
    if (resourceUri) {
        const uriRev = getRevisionFromUri(resourceUri);
        if (uriRev) {
            return uriRev !== '@' && !uriRev.includes(' ') && uriRev.length > 8 ? uriRev.slice(0, 8) : uriRev;
        }
    }
    const suffixMatch = /\(([^)]+)\)\s*$/.exec(filename);
    if (suffixMatch?.[1]) {
        const suffix = suffixMatch[1].trim();
        return suffix !== '@' && !suffix.includes(' ') && suffix.length > 8 ? suffix.slice(0, 8) : suffix;
    }
    if (isWorkingCopy) {
        return '@';
    }
    return undefined;
}

/**
 * Infers 1-based inclusive start and end line numbers by matching a snippet against file content.
 */
export function inferLineRangeFromContent(
    content: string,
    snippet: string,
): { startLine: number; endLine: number } | undefined {
    if (!content || !snippet) {
        return undefined;
    }
    const normContent = content.replace(/\r\n/g, '\n');
    const normSnippet = snippet.replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (!normSnippet) {
        return undefined;
    }
    const idx = normContent.indexOf(normSnippet);
    if (idx === -1) {
        return undefined;
    }
    const prefix = normContent.slice(0, idx);
    const startLine = prefix.split('\n').length;
    const lineCount = normSnippet.split('\n').length;
    return {
        startLine,
        endLine: startLine + lineCount - 1,
    };
}

function getShadowSelection(root: ShadowRoot): Selection | null {
    const withSel: ShadowRootWithSelection = root;
    if (typeof withSel.getSelection === 'function') {
        return withSel.getSelection();
    }
    return null;
}

function findLineElement(node: Node | null): Element | null {
    if (!node) {
        return null;
    }
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) {
        return null;
    }
    return el.closest('[data-line]');
}

function parseLineNumber(lineEl: Element | null): number | undefined {
    if (!lineEl) {
        return undefined;
    }
    const raw = lineEl.getAttribute('data-line') ?? lineEl.getAttribute('data-column-number');
    if (!raw) {
        return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function detectSideFromElement(lineEl: Element | null): 'deletions' | 'additions' | undefined {
    if (!lineEl) {
        return undefined;
    }
    if (lineEl.closest('[data-deletions]')) {
        return 'deletions';
    }
    if (lineEl.closest('[data-additions]')) {
        return 'additions';
    }
    return undefined;
}

function extractSelectionDetails(sel: Selection, diffsContainer?: Element): DomExtractedSelection | undefined {
    const rawText = sel.toString().replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (rawText.trim().length === 0) {
        return undefined;
    }

    const anchorLineEl = findLineElement(sel.anchorNode);
    const focusLineEl = findLineElement(sel.focusNode);
    const lineA = parseLineNumber(anchorLineEl);
    const lineB = parseLineNumber(focusLineEl);
    const side = detectSideFromElement(anchorLineEl) ?? detectSideFromElement(focusLineEl);

    let startLine: number | undefined;
    let endLine: number | undefined;
    if (lineA !== undefined && lineB !== undefined) {
        startLine = Math.min(lineA, lineB);
        const rawEnd = Math.max(lineA, lineB);
        const lineCount = rawText.split('\n').length;
        // When triple-clicking or dragging to the end of a line, focusOffset is 0 on the next line.
        if (sel.focusOffset === 0 && rawEnd > startLine) {
            endLine = Math.max(startLine, Math.min(rawEnd - 1, startLine + lineCount - 1));
        } else {
            endLine = rawEnd;
        }
    } else if (lineA !== undefined) {
        startLine = lineA;
        endLine = lineA + rawText.split('\n').length - 1;
    }

    return {
        selectedText: rawText,
        startLine,
        endLine,
        side,
        diffsContainer,
    };
}

/**
 * Extracts active DOM or ShadowRoot text selection within a viewer container element.
 */
export function extractDomSelectionFromContainer(containerEl: HTMLElement | null): DomExtractedSelection | undefined {
    if (!containerEl || typeof window === 'undefined') {
        return undefined;
    }

    const diffsHosts = Array.from(containerEl.querySelectorAll('diffs-container'));
    for (const hostEl of diffsHosts) {
        const shadowRoot = hostEl.shadowRoot;
        if (!shadowRoot) {
            continue;
        }
        const shadowSel = getShadowSelection(shadowRoot);
        if (
            shadowSel &&
            !shadowSel.isCollapsed &&
            (!shadowSel.anchorNode || shadowRoot.contains(shadowSel.anchorNode))
        ) {
            const extracted = extractSelectionDetails(shadowSel, hostEl);
            if (extracted) {
                return extracted;
            }
        }
    }

    const winSel = window.getSelection?.();
    if (!winSel || winSel.isCollapsed) {
        return undefined;
    }

    const anchor = winSel.anchorNode;
    if (anchor) {
        if (containerEl.contains(anchor)) {
            const matchingHost = diffsHosts.find((h) => h.contains(anchor));
            return extractSelectionDetails(winSel, matchingHost);
        }
        for (const hostEl of diffsHosts) {
            if (hostEl.shadowRoot?.contains(anchor)) {
                return extractSelectionDetails(winSel, hostEl);
            }
        }
        return undefined;
    }

    return undefined;
}

export interface ResolveDiffOrFileSelectionOptions {
    filename: string;
    resourceUri?: Uri;
    isWorkingCopy?: boolean;
    originalContent?: string;
    modifiedContent: string;
    containerEl: HTMLElement | null;
    editorInstance?: PierreEditorLike | null;
    selectedRanges?: { startLine: number; endLine: number }[];
    selectedLineSide?: 'deletions' | 'additions';
}

/**
 * Resolves the active selection in a single-file diff or file viewer across:
 * 1. Pierre Editor selection (`@pierre/diffs/edit`)
 * 2. DOM / ShadowRoot text selection
 * 3. Pierre gutter line selection (`selectedRanges`)
 */
export function resolveDiffOrFileSelection(
    options: ResolveDiffOrFileSelectionOptions,
): EditorChatContextSelection | undefined {
    const cleanName = cleanViewerFilename(options.filename);
    const fsPath = options.resourceUri ? getFsPathFromUri(options.resourceUri) : undefined;
    const revision = extractViewerRevision(options.filename, options.resourceUri, options.isWorkingCopy);

    // 1. Check Pierre Editor selection when editing is active
    const editState = options.editorInstance?.getEditState();
    const editorSelections = editState?.editor.selections;
    if (editState && editorSelections && editorSelections.length > 0) {
        const nonCollapsed = editorSelections.find(
            (s) => s.start.line !== s.end.line || s.start.character !== s.end.character,
        );
        if (nonCollapsed) {
            const rawText = editState.document.getText(nonCollapsed).replace(/\r\n/g, '\n').replace(/\n$/, '');
            if (rawText.trim().length > 0) {
                const startLine = nonCollapsed.start.line + 1;
                const endLine =
                    nonCollapsed.end.character === 0 && nonCollapsed.end.line > nonCollapsed.start.line
                        ? nonCollapsed.end.line
                        : nonCollapsed.end.line + 1;
                const side = editState.editor.activeBuffer === 'deletions' ? 'deletions' : 'additions';
                return {
                    filename: cleanName,
                    fsPath,
                    revision,
                    startLine,
                    endLine,
                    side,
                    selectedText: rawText,
                };
            }
        }
    }

    // 2. Check DOM / ShadowRoot text selection
    const domSel = extractDomSelectionFromContainer(options.containerEl);
    if (domSel) {
        let startLine = domSel.startLine;
        let endLine = domSel.endLine;
        let side = domSel.side;
        if (startLine === undefined || endLine === undefined) {
            const primaryContent = side === 'deletions' ? (options.originalContent ?? '') : options.modifiedContent;
            const inferredPrimary = inferLineRangeFromContent(primaryContent, domSel.selectedText);
            if (inferredPrimary) {
                startLine = inferredPrimary.startLine;
                endLine = inferredPrimary.endLine;
            } else if (options.originalContent) {
                const inferredOrig = inferLineRangeFromContent(options.originalContent, domSel.selectedText);
                if (inferredOrig) {
                    startLine = inferredOrig.startLine;
                    endLine = inferredOrig.endLine;
                    side = side ?? 'deletions';
                }
            }
        }
        return {
            filename: cleanName,
            fsPath,
            revision,
            startLine,
            endLine,
            side,
            selectedText: domSel.selectedText,
        };
    }

    // 3. Check Pierre gutter line selection
    if (options.selectedRanges && options.selectedRanges.length > 0) {
        const range = options.selectedRanges[0];
        const side = options.selectedLineSide;
        const sourceContent = side === 'deletions' ? (options.originalContent ?? '') : options.modifiedContent;
        const lines = sourceContent.replace(/\r\n/g, '\n').split('\n');
        if (lines.length === 0) {
            return undefined;
        }
        const clampedStart = Math.max(0, Math.min(range.startLine, lines.length - 1));
        const clampedEnd = Math.max(clampedStart, Math.min(range.endLine, lines.length - 1));
        const selectedText = lines.slice(clampedStart, clampedEnd + 1).join('\n');
        if (selectedText.trim().length === 0) {
            return undefined;
        }
        return {
            filename: cleanName,
            fsPath,
            revision,
            startLine: clampedStart + 1,
            endLine: clampedEnd + 1,
            side,
            selectedText,
        };
    }

    return undefined;
}

export interface ResolveMultiDiffSelectionOptions {
    files: readonly MultiDiffFileEntry[];
    containerEl: HTMLElement | null;
    codeView?: PierreCodeViewLike | null;
}

/**
 * Resolves the active selection in a multi-file diff viewer across DOM text selection
 * and Pierre CodeView gutter line selection.
 */
export function resolveMultiDiffSelection(
    options: ResolveMultiDiffSelectionOptions,
): EditorChatContextSelection | undefined {
    // 1. Check DOM / ShadowRoot text selection
    const domSel = extractDomSelectionFromContainer(options.containerEl);
    if (domSel) {
        let matchedEntry: MultiDiffFileEntry | undefined;
        const diffsContainer = domSel.diffsContainer;
        if (diffsContainer && options.codeView) {
            const rendered = options.codeView.getRenderedItems();
            const matchedItem = rendered.find(
                (item) => item.container === diffsContainer || item.container.contains(diffsContainer),
            );
            if (matchedItem) {
                matchedEntry = options.files.find((f) => cleanViewerFilename(f.filename) === matchedItem.id);
            }
        }
        if (!matchedEntry) {
            matchedEntry = options.files.find(
                (f) =>
                    inferLineRangeFromContent(f.modifiedContent ?? '', domSel.selectedText) !== undefined ||
                    inferLineRangeFromContent(f.originalContent ?? '', domSel.selectedText) !== undefined,
            );
        }
        const targetEntry = matchedEntry ?? options.files[0];
        if (!targetEntry) {
            return undefined;
        }
        const cleanName = cleanViewerFilename(targetEntry.filename);
        const targetUri =
            domSel.side === 'deletions' ? targetEntry.leftUri : (targetEntry.rightUri ?? targetEntry.leftUri);
        const fsPath = targetUri ? getFsPathFromUri(targetUri) : undefined;
        const revision = extractViewerRevision(targetEntry.filename, targetUri, targetEntry.isWorkingCopy);

        let startLine = domSel.startLine;
        let endLine = domSel.endLine;
        let side = domSel.side;
        if (startLine === undefined || endLine === undefined) {
            const primaryContent =
                side === 'deletions' ? (targetEntry.originalContent ?? '') : (targetEntry.modifiedContent ?? '');
            const inferred = inferLineRangeFromContent(primaryContent, domSel.selectedText);
            if (inferred) {
                startLine = inferred.startLine;
                endLine = inferred.endLine;
            } else if (targetEntry.originalContent) {
                const inferredOrig = inferLineRangeFromContent(targetEntry.originalContent, domSel.selectedText);
                if (inferredOrig) {
                    startLine = inferredOrig.startLine;
                    endLine = inferredOrig.endLine;
                    side = side ?? 'deletions';
                }
            }
        }

        return {
            filename: cleanName,
            fsPath,
            revision,
            startLine,
            endLine,
            side,
            selectedText: domSel.selectedText,
        };
    }

    // 2. Check CodeView gutter line selection
    const selectedLines = options.codeView?.getSelectedLines();
    if (selectedLines && typeof selectedLines.range.start === 'number' && typeof selectedLines.range.end === 'number') {
        const entry = options.files.find((f) => cleanViewerFilename(f.filename) === selectedLines.id);
        if (!entry) {
            return undefined;
        }
        const side = selectedLines.range.side;
        const sourceContent = side === 'deletions' ? (entry.originalContent ?? '') : (entry.modifiedContent ?? '');
        const lines = sourceContent.replace(/\r\n/g, '\n').split('\n');
        if (lines.length === 0) {
            return undefined;
        }
        const startIdx = Math.max(0, Math.min(selectedLines.range.start, selectedLines.range.end) - 1);
        const endIdx = Math.max(
            startIdx,
            Math.min(Math.max(selectedLines.range.start, selectedLines.range.end) - 1, lines.length - 1),
        );
        const selectedText = lines.slice(startIdx, endIdx + 1).join('\n');
        if (selectedText.trim().length === 0) {
            return undefined;
        }
        const targetUri = side === 'deletions' ? entry.leftUri : (entry.rightUri ?? entry.leftUri);
        return {
            filename: cleanViewerFilename(entry.filename),
            fsPath: targetUri ? getFsPathFromUri(targetUri) : undefined,
            revision: extractViewerRevision(entry.filename, targetUri, entry.isWorkingCopy),
            startLine: startIdx + 1,
            endLine: endIdx + 1,
            side,
            selectedText,
        };
    }

    return undefined;
}

/**
 * Formats a compact badge label such as `src/app.ts:12-18` or `src/app.ts:12`.
 */
export function formatSelectionBadgeLabel(selection: EditorChatContextSelection): string {
    if (selection.startLine !== undefined && selection.endLine !== undefined) {
        if (selection.startLine === selection.endLine) {
            return `${selection.filename}:${selection.startLine}`;
        }
        return `${selection.filename}:${selection.startLine}-${selection.endLine}`;
    }
    return selection.filename;
}

/**
 * Formats secondary badge metadata (e.g. revision and diff side).
 */
export function formatSelectionBadgeDetail(selection: EditorChatContextSelection): string | undefined {
    const parts: string[] = [];
    if (selection.revision) {
        parts.push(selection.revision === '@' ? 'working copy (@)' : `rev ${selection.revision}`);
    }
    if (selection.side === 'deletions') {
        parts.push('deleted lines');
    }
    return parts.length > 0 ? parts.join(' • ') : undefined;
}

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    svelte: 'svelte',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    xml: 'xml',
};

/**
 * Infers a markdown code-fence language identifier from a filename.
 */
export function inferCodeFenceLanguage(filename: string): string {
    const clean = cleanViewerFilename(filename);
    const dotIdx = clean.lastIndexOf('.');
    if (dotIdx === -1 || dotIdx === clean.length - 1) {
        return '';
    }
    const ext = clean.slice(dotIdx + 1).toLowerCase();
    return EXTENSION_LANGUAGE_MAP[ext] ?? ext;
}

/**
 * Formats the selected code context and user instruction into a structured markdown message for the agent.
 */
export function formatChatContextMessage(selection: EditorChatContextSelection, userPrompt?: string): string {
    const badge = formatSelectionBadgeLabel(selection);
    const detail = formatSelectionBadgeDetail(selection);
    const header = detail ? `Context from \`${badge}\` (${detail}):` : `Context from \`${badge}\`:`;
    const lang = inferCodeFenceLanguage(selection.filename);
    const fence = selection.selectedText.includes('```') ? '````' : '```';
    const codeBlock = `${fence}${lang}\n${selection.selectedText}\n${fence}`;
    const trimmedPrompt = userPrompt?.trim();
    if (trimmedPrompt) {
        return `${header}\n${codeBlock}\n\n${trimmedPrompt}`;
    }
    return `${header}\n${codeBlock}`;
}
