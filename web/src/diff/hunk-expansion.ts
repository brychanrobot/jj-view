/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// web/src/diff/hunk-expansion.ts
// Single-Row Split-Paper Center-Seam Pill Cluster +
// Progressive AST +Block + Middle-Button Monotonic Expand-Only Drag

import { type ExpansionDirections, FileDiff, type FileDiffMetadata } from '@pierre/diffs';
import {
    type AstBlockTarget,
    type AstBlockTargets,
    buildSyntaxBlocks,
    clampExpansionLines,
    computeAstBlockTargets,
    createSvgIcon,
    DEFAULT_LINE_HEIGHT_PX,
    type ExpandedHunkRegion,
    getHunkGapLineRanges,
    type HunkGapLineRanges,
    MINIMUM_LINES_TO_HIDE,
    type SyntaxBlock,
} from './hunk-expansion-ast';

export * from './hunk-expansion-ast';

export interface HunkExpansionControllerHost {
    getRenderedDiff(): FileDiffMetadata | undefined;
    getExpandedHunk(hunkIndex: number): ExpandedHunkRegion | undefined;
    expandHunk(hunkIndex: number, direction: 'up' | 'down' | 'both', expansionLineCountOverride?: number): void;
    getDiffStyle(): 'split' | 'unified';
    getShadowRoot?(): HTMLElement | ShadowRoot | ParentNode | null | undefined;
    getContainer?(): HTMLElement | ShadowRoot | ParentNode | null | undefined;
    preloadFullContents?: () => Promise<void>;
}

export const HUNK_EXPANSION_CSS = `
  :host, [data-diffs] {
    --seam-recess-bg: color-mix(in srgb, var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background)) 82%, var(--vscode-input-border, var(--vscode-widget-border)));
    --seam-shadow: inset 0 2px 5px color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-foreground)) 12%, transparent);
    --accent-primary: var(--vscode-focusBorder, var(--vscode-button-background));
    --bg-elevated: var(--vscode-input-background, var(--vscode-sideBar-background));
    --bg-hover: var(--vscode-list-hoverBackground);
    --bg-surface: var(--vscode-editor-background);
    --border-subtle: var(--vscode-input-border, var(--vscode-widget-border));
    --border-focus: var(--vscode-focusBorder);
    --text-primary: var(--vscode-foreground);
    --text-secondary: var(--vscode-descriptionForeground);
    --text-muted: var(--vscode-descriptionForeground);
    --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    --font-mono: var(--vscode-editor-font-family, 'JetBrains Mono', 'Fira Code', monospace);
    --pill-bg: var(--bg-elevated);
    --pill-bg-hover: var(--bg-hover);
    --pill-border: var(--border-subtle);
    --diffs-column-number-width: 48px;
    --diffs-selection-color: var(
      --vscode-editor-selectionBackground,
      color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent)
    );
    --diffs-editor-selection-bg: var(--diffs-selection-color);
  }

  /* Text Selection Highlights (Adopted StyleSheet sits after all Shadow DOM <style> tags) */
  ::selection {
    background-color: var(--diffs-selection-color);
  }

  [data-diffs]:has([data-selection-range]) ::selection {
    background-color: transparent;
  }

  [data-deleted-text-selection] [data-deletions] ::selection,
  [data-deleted-text-selection] [data-line-type="change-deletion"] ::selection {
    background-color: var(--diffs-selection-color);
  }

  [data-selection-range] {
    background-color: var(--diffs-selection-color);
  }

  /* Expanded Context Rows */
  [data-line][data-line-type="context-expanded"],
  [data-diffs] [data-line][data-line-type="context-expanded"] {
    --diffs-line-bg: color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--vscode-editor-background));
    background-color: color-mix(in srgb, var(--vscode-focusBorder) 7%, transparent);
  }

  [data-column-number][data-line-type="context-expanded"],
  [data-diffs] [data-column-number][data-line-type="context-expanded"] {
    background-color: color-mix(in srgb, var(--vscode-focusBorder) 14%, var(--vscode-editor-background));
    box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
    color: var(--vscode-foreground);
  }

  /* Ensure containers do not crop the elevated seam bar or tooltips */
  [data-code],
  [data-separator],
  [data-separator="line-info"],
  [data-separator-wrapper],
  [data-separator-content],
  [data-diffs] [data-code],
  [data-diffs] [data-separator],
  [data-diffs] [data-separator="line-info"],
  [data-diffs] [data-separator-wrapper],
  [data-diffs] [data-separator-content] {
    overflow: visible;
  }

  /* Single-Row Center Seam Bar */
  [data-line]:has([data-separator="line-info"]),
  [data-row]:has([data-separator="line-info"]),
  [data-content]:has([data-separator="line-info"]),
  [data-column-content]:has([data-separator="line-info"]),
  [data-deletions]:has([data-separator="line-info"]),
  [data-additions]:has([data-separator="line-info"]),
  [data-separator="line-info"][data-expand-index],
  [data-diffs] [data-line]:has([data-separator="line-info"]),
  [data-diffs] [data-row]:has([data-separator="line-info"]),
  [data-diffs] [data-content]:has([data-separator="line-info"]),
  [data-diffs] [data-column-content]:has([data-separator="line-info"]),
  [data-diffs] [data-deletions]:has([data-separator="line-info"]),
  [data-diffs] [data-additions]:has([data-separator="line-info"]),
  [data-diffs] [data-separator="line-info"][data-expand-index] {
    cursor: pointer;
    overflow: visible;
    contain: none;
    position: relative;
    padding: 0;
    min-height: 32px;
    height: 32px;
    background: var(--seam-recess-bg);
    border-top: 1px solid var(--vscode-widget-border);
    border-bottom: 1px solid var(--vscode-widget-border);
    box-shadow: var(--seam-shadow);
    z-index: 50;
  }

  [data-gutter] [data-separator="line-info"][data-expand-index],
  [data-diffs] [data-gutter] [data-separator="line-info"][data-expand-index] {
    background: var(--seam-recess-bg);
    box-shadow: var(--seam-shadow);
  }

  [data-separator="line-info"][data-expand-index] [data-separator-wrapper],
  [data-diffs] [data-separator="line-info"][data-expand-index] [data-separator-wrapper] {
    display: none;
    border-top: 1px solid var(--vscode-widget-border);
    border-bottom: 1px solid var(--vscode-widget-border);
  }

  .combo-seam, .combo-seam-half {
    position: sticky;
    left: var(--diffs-column-number-width, 48px);
    width: calc(100cqi - var(--diffs-column-number-width, 48px));
    max-width: 100%;
    height: 32px;
    min-height: 32px;
    display: flex;
    align-items: center;
    box-sizing: border-box;
    user-select: none;
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--text-primary);
  }

  .combo-seam {
    padding: 0 12px;
  }

  .combo-seam-half.deletions-half { justify-content: flex-start; }
  .combo-seam-half.additions-half { justify-content: flex-end; }

  /* Top & Bottom Interactive Drag-to-Peel Edge Strips */
  .seam-drag-edge {
    position: absolute;
    left: 0;
    right: 0;
    height: 5px;
    cursor: ns-resize;
    z-index: 6;
    transition: background 0.12s ease;
  }

  .seam-drag-edge.top-edge {
    top: -2px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent-primary) 30%, transparent), transparent);
  }

  .seam-drag-edge.bottom-edge {
    bottom: -2px;
    background: linear-gradient(0deg, color-mix(in srgb, var(--accent-primary) 30%, transparent), transparent);
  }

  .seam-drag-edge:hover,
  .seam-drag-edge.dragging {
    background: var(--accent-primary);
    height: 4px;
  }

  .seam-main-row {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    gap: 8px;
    position: relative;
    z-index: 4;
  }

  .seam-main-row-half {
    display: flex;
    align-items: center;
    width: 100%;
    position: relative;
    z-index: 4;
  }

  .seam-main-right {
    justify-content: flex-end;
  }

  .seam-center-cluster {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: nowrap;
    gap: 6px;
  }

  .seam-center-cluster.seam-straddle {
    position: absolute;
    left: calc(-1 * var(--diffs-column-number-width, 48px));
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 10;
  }

  .dock-pair-group {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .dock-pair {
    display: inline-flex;
    align-items: center;
    background: var(--pill-bg);
    border: 1px solid var(--pill-border);
    border-radius: 12px;
    padding: 0;
    overflow: hidden;
    box-shadow: 0 2px 6px color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-foreground)) 18%, transparent);
  }

  .dock-pair.dock-top {
    border-top-left-radius: 4px;
    border-top-right-radius: 4px;
  }

  .dock-pair.dock-bottom {
    border-bottom-left-radius: 4px;
    border-bottom-right-radius: 4px;
  }

  .dock-pair.dock-top:hover, .dock-pair.dock-bottom:hover {
    border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-subtle));
  }

  .dock-pair .seam-pill:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }

  .seam-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 9px;
    border-radius: 999px;
    background: var(--pill-bg);
    border: 1px solid var(--pill-border);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
    box-sizing: border-box;
  }

  .dock-pair .seam-pill {
    border: none;
    height: 22px;
    padding: 0 8px;
    border-radius: 0;
    box-shadow: none;
    background: transparent;
  }

  .dock-pair .seam-pill + .seam-pill {
    border-left: 1px solid var(--border-subtle);
  }

  .seam-pill:hover {
    background: var(--pill-bg-hover);
    border-color: var(--accent-primary);
  }

  .dock-pair .seam-pill:hover {
    background: var(--pill-bg-hover);
  }

  .seam-pill.pill-all {
    background: var(--bg-surface);
    font-weight: 600;
    cursor: ns-resize;
    padding: 0 11px;
    box-shadow: 0 2px 6px color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-foreground)) 18%, transparent);
  }

  .seam-pill.pill-all .grip-dots {
    opacity: 0.6;
    transition: opacity 0.12s ease, color 0.12s ease;
  }

  .seam-pill.pill-all:hover {
    background: var(--bg-hover);
    border-color: var(--accent-primary);
    box-shadow: 0 3px 10px color-mix(in srgb, var(--accent-primary) 25%, transparent);
  }

  .seam-pill.pill-all:hover .grip-dots {
    opacity: 1;
    color: var(--accent-primary);
  }

  .seam-pill.pill-ast {
    color: var(--vscode-textLink-foreground, var(--accent-primary));
    font-weight: 600;
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  }

  .seam-pill.pill-ast:hover {
    background: color-mix(in srgb, var(--accent-primary) 22%, transparent);
    color: var(--vscode-foreground);
  }

  .dock-pair .seam-pill.pill-ast {
    color: var(--vscode-textLink-foreground, var(--accent-primary));
    font-weight: 600;
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  }

  .dock-pair .seam-pill.pill-ast:hover {
    background: color-mix(in srgb, var(--accent-primary) 22%, transparent);
    color: var(--vscode-foreground);
  }

  .ast-fn-token {
    font-family: var(--font-mono);
    font-size: 10.5px;
  }

  .ast-pill-anchor {
    position: relative;
    display: inline-flex;
  }

  .ast-tooltip {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 380px;
    max-width: 90vw;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--vscode-sideBar-background);
    border: 1px solid color-mix(in srgb, var(--accent-primary) 50%, var(--border-subtle));
    box-shadow: 0 10px 28px color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-foreground)) 28%, transparent);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.13s ease;
    z-index: 99999;
    text-align: left;
  }

  .ast-tooltip.tooltip-below { top: calc(100% + 7px); }
  .ast-tooltip.tooltip-above { bottom: calc(100% + 7px); }

  .ast-pill-anchor:has(.pill-ast:hover) > .ast-tooltip,
  .ast-pill-anchor:has(.pill-ast:focus-visible) > .ast-tooltip,
  .ast-pill-anchor.force-tooltip-open > .ast-tooltip {
    opacity: 1;
    visibility: visible;
    display: block;
    transition: none;
    pointer-events: auto;
  }

  .ast-tooltip-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .ast-tooltip-header .tt-badge {
    background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
    color: var(--vscode-textLink-foreground, var(--accent-primary));
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9.5px;
    font-weight: 600;
  }

  .ast-tooltip-path {
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-primary);
    margin-bottom: 5px;
    flex-wrap: wrap;
  }

  .ast-tooltip-code {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 4px 6px;
    border-radius: 4px;
    background: var(--vscode-editor-background);
    border-left: 2px solid var(--accent-primary);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 920px) {
    .ast-tooltip {
      width: 280px;
    }
  }
`;

let diffCustomStyleSheet: CSSStyleSheet | undefined;

function isShadowRoot(node: unknown): node is ShadowRoot {
    if (typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot) {
        return true;
    }
    return (
        typeof node === 'object' &&
        node !== null &&
        'nodeType' in node &&
        (node as Node).nodeType === 11 &&
        'host' in node &&
        'adoptedStyleSheets' in node
    );
}

function getAdoptableShadowRoot(root: ParentNode | null | undefined): ShadowRoot | null {
    if (!root) {
        return null;
    }
    if (isShadowRoot(root)) {
        return root;
    }
    if ('shadowRoot' in root && isShadowRoot(root.shadowRoot)) {
        return root.shadowRoot;
    }
    if ('querySelector' in root) {
        const diffsContainer = root.querySelector('diffs-container');
        if (diffsContainer && 'shadowRoot' in diffsContainer && isShadowRoot(diffsContainer.shadowRoot)) {
            return diffsContainer.shadowRoot;
        }
    }
    return null;
}

/**
 * Adopts HUNK_EXPANSION_CSS into the target's shadowRoot as an unlayered Constructable
 * CSSStyleSheet. Because adoptedStyleSheets are unlayered and evaluated after all <style>
 * tags in the Shadow DOM by standard CSS Cascade rules, rules win without !important.
 */
export function adoptDiffCustomStyles(root: ParentNode | null | undefined): void {
    if (!root || typeof CSSStyleSheet === 'undefined') {
        return;
    }
    const targetShadow = getAdoptableShadowRoot(root);
    if (!targetShadow) {
        return;
    }
    if (!diffCustomStyleSheet && 'replaceSync' in CSSStyleSheet.prototype) {
        diffCustomStyleSheet = new CSSStyleSheet();
        diffCustomStyleSheet.replaceSync(HUNK_EXPANSION_CSS);
    }
    if (diffCustomStyleSheet && !targetShadow.adoptedStyleSheets.includes(diffCustomStyleSheet)) {
        targetShadow.adoptedStyleSheets = [...targetShadow.adoptedStyleSheets, diffCustomStyleSheet];
    }
}

export interface SeamPointerEventLike {
    button?: number;
    clientY: number;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}

export interface StartSeamInteractionOptions {
    event: SeamPointerEventLike;
    hunkIndex: number;
    host: HunkExpansionControllerHost;
    clickActionFn?: () => void;
    getLineHeightPx: () => number;
    eventTarget?: {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
    };
}

export function startSeamInteraction(params: StartSeamInteractionOptions): void {
    const { event, hunkIndex, host, clickActionFn, getLineHeightPx, eventTarget } = params;
    if (event.button !== undefined && event.button !== 0) {
        return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();

    const fileDiff = host.getRenderedDiff();
    if (!fileDiff) {
        return;
    }

    const win = eventTarget ?? (typeof window !== 'undefined' ? window : undefined);
    const startY = event.clientY;
    let lastY = event.clientY;
    const region = host.getExpandedHunk(hunkIndex) ?? { fromStart: 0, fromEnd: 0 };
    const baseFromStart = region.fromStart;
    const baseFromEnd = region.fromEnd;
    const gap = getHunkGapLineRanges(fileDiff, hunkIndex, region);
    const totalLines = gap.rangeSize;
    const lineHeightPx = getLineHeightPx() || DEFAULT_LINE_HEIGHT_PX;
    let didMove = false;
    let currentFromStart = baseFromStart;
    let currentFromEnd = baseFromEnd;
    let downAccumPx = 0;
    let upAccumPx = 0;
    let lastDirection: 'up' | 'down' = 'down';

    const onPointerMove = (moveEvent: PointerEvent | MouseEvent | { clientY: number }): void => {
        if (!didMove) {
            const initialDelta = moveEvent.clientY - startY;
            if (Math.abs(initialDelta) <= 2) {
                return;
            }
            didMove = true;
            if (typeof document !== 'undefined') {
                document.body.classList.add('is-dragging-seam');
            }
        }

        const dy = moveEvent.clientY - lastY;
        lastY = moveEvent.clientY;
        if (dy === 0) {
            return;
        }

        if (dy > 0) {
            // Moving DOWN: expands lines ABOVE the fold (downward from upper hunk)
            upAccumPx = Math.max(0, upAccumPx - dy * 0.5);
            if (hunkIndex > 0) {
                lastDirection = 'down';
                downAccumPx += dy;
                const remaining = totalLines - currentFromStart - currentFromEnd;
                const addAbove = Math.min(remaining, Math.floor(downAccumPx / lineHeightPx));
                if (addAbove > 0) {
                    downAccumPx -= addAbove * lineHeightPx;
                    host.expandHunk(hunkIndex, 'up', addAbove);
                    const updated = host.getExpandedHunk(hunkIndex);
                    currentFromStart = Math.max(currentFromStart + addAbove, updated?.fromStart ?? 0);
                    currentFromEnd = Math.max(currentFromEnd, updated?.fromEnd ?? 0);
                }
            }
        } else if (dy < 0) {
            // Moving UP: expands lines BELOW the fold (upward from lower hunk)
            downAccumPx = Math.max(0, downAccumPx + dy * 0.5);
            if (hunkIndex < fileDiff.hunks.length) {
                lastDirection = 'up';
                upAccumPx += -dy;
                const remaining = totalLines - currentFromStart - currentFromEnd;
                const addBelow = Math.min(remaining, Math.floor(upAccumPx / lineHeightPx));
                if (addBelow > 0) {
                    upAccumPx -= addBelow * lineHeightPx;
                    host.expandHunk(hunkIndex, 'down', addBelow);
                    const updated = host.getExpandedHunk(hunkIndex);
                    currentFromEnd = Math.max(currentFromEnd + addBelow, updated?.fromEnd ?? 0);
                    currentFromStart = Math.max(currentFromStart, updated?.fromStart ?? 0);
                }
            }
        }
    };

    const onPointerUp = (): void => {
        if (win) {
            win.removeEventListener('pointermove', onPointerMove as EventListener);
            win.removeEventListener('pointerup', onPointerUp as EventListener);
            win.removeEventListener('pointercancel', onPointerUp as EventListener);
            win.removeEventListener('mousemove', onPointerMove as EventListener);
            win.removeEventListener('mouseup', onPointerUp as EventListener);
        }
        if (typeof document !== 'undefined') {
            document.body.classList.remove('is-dragging-seam');
        }

        if (!didMove) {
            clickActionFn?.();
            return;
        }

        const remaining = totalLines - currentFromStart - currentFromEnd;
        if (remaining > 0 && remaining < MINIMUM_LINES_TO_HIDE) {
            if (lastDirection === 'down' && hunkIndex > 0) {
                host.expandHunk(hunkIndex, 'up', remaining);
            } else if (hunkIndex < fileDiff.hunks.length) {
                host.expandHunk(hunkIndex, 'down', remaining);
            } else {
                host.expandHunk(hunkIndex, 'both', Number.POSITIVE_INFINITY);
            }
        }
    };

    if (win) {
        win.addEventListener('pointermove', onPointerMove as EventListener);
        win.addEventListener('pointerup', onPointerUp as EventListener);
        win.addEventListener('pointercancel', onPointerUp as EventListener);
        win.addEventListener('mousemove', onPointerMove as EventListener);
        win.addEventListener('mouseup', onPointerUp as EventListener);
    }
}

/**
 * Controller that injects the single-row center seam UI into Pierre's separator elements.
 */
interface StyleCarrier {
    style: CSSStyleDeclaration;
}

function isStyleCarrier(node: unknown): node is StyleCarrier {
    return (
        typeof node === 'object' &&
        node !== null &&
        'style' in node &&
        typeof (node as StyleCarrier).style === 'object' &&
        (node as StyleCarrier).style !== null
    );
}

function getStyleCarrier(root: ParentNode | null | undefined): StyleCarrier | null {
    if (!root) {
        return null;
    }
    if ('host' in root && isStyleCarrier(root.host)) {
        return root.host;
    }
    if (isStyleCarrier(root)) {
        return root;
    }
    return null;
}

export function syncHostColumnNumberWidth(root: ParentNode | null | undefined, clearOnly = false): void {
    const hostEl = getStyleCarrier(root);
    if (!hostEl || typeof hostEl.style.removeProperty !== 'function') {
        return;
    }
    if (clearOnly || !root || !('querySelector' in root)) {
        hostEl.style.removeProperty('--diffs-column-number-width');
        return;
    }
    const gutterEl = root.querySelector<HTMLElement>(
        '[data-additions] [data-gutter], [data-additions] [data-column-number], [data-gutter], [data-column-number]',
    );
    if (gutterEl && typeof gutterEl.getBoundingClientRect === 'function') {
        const measuredWidth = gutterEl.getBoundingClientRect().width;
        if (measuredWidth > 0 && typeof hostEl.style.setProperty === 'function') {
            hostEl.style.setProperty('--diffs-column-number-width', `${Math.round(measuredWidth)}px`);
            return;
        }
    }
    hostEl.style.removeProperty('--diffs-column-number-width');
}

export class HunkExpansionController {
    private syntaxBlocksCache: {
        diff: FileDiffMetadata;
        linesCount: number;
        fileName?: string;
        blocks: SyntaxBlock[];
    } | null = null;

    constructor(private readonly host: HunkExpansionControllerHost) {}

    resetCache(): void {
        this.syntaxBlocksCache = null;
    }

    getRoot(): ParentNode | null | undefined {
        return this.host.getContainer?.() ?? this.host.getShadowRoot?.();
    }

    getRenderedLineHeight(): number {
        const root = this.getRoot();
        if (root && 'querySelector' in root) {
            const sample = root.querySelector<HTMLElement>('[data-line], [data-column-number]');
            if (sample) {
                const h = sample.getBoundingClientRect().height;
                if (h > 8) {
                    return h;
                }
            }
        }
        return DEFAULT_LINE_HEIGHT_PX;
    }

    measureLineHeightPx(): number {
        return this.getRenderedLineHeight();
    }

    getSyntaxBlocks(fileDiff: FileDiffMetadata): readonly SyntaxBlock[] {
        if (fileDiff.isPartial) {
            return [];
        }
        const lines =
            fileDiff.additionLines && fileDiff.additionLines.length > 0
                ? fileDiff.additionLines
                : fileDiff.deletionLines && fileDiff.deletionLines.length > 0
                  ? fileDiff.deletionLines
                  : [];
        if (lines.length === 0) {
            return [];
        }
        if (
            this.syntaxBlocksCache &&
            this.syntaxBlocksCache.diff === fileDiff &&
            this.syntaxBlocksCache.linesCount === lines.length &&
            this.syntaxBlocksCache.fileName === fileDiff.name
        ) {
            return this.syntaxBlocksCache.blocks;
        }
        const blocks = buildSyntaxBlocks(lines, fileDiff.name);
        this.syntaxBlocksCache = {
            diff: fileDiff,
            linesCount: lines.length,
            fileName: fileDiff.name,
            blocks,
        };
        return blocks;
    }

    enhanceSeparators(): void {
        const root = this.getRoot();
        if (!root || !('querySelectorAll' in root)) {
            return;
        }
        adoptDiffCustomStyles(root);
        const fileDiff = this.host.getRenderedDiff();
        if (!fileDiff?.hunks || fileDiff.hunks.length === 0) {
            syncHostColumnNumberWidth(root, true);
            const stale = root.querySelectorAll('.jj-hunk-seam');
            for (const el of Array.from(stale)) {
                el.remove();
            }
            return;
        }
        syncHostColumnNumberWidth(root, false);

        const diffStyle = this.host.getDiffStyle();
        const blocks = this.getSyntaxBlocks(fileDiff);
        const previewLines = fileDiff.additionLines ?? fileDiff.deletionLines ?? [];

        const separators = root.querySelectorAll<HTMLElement>('[data-separator="line-info"][data-expand-index]');

        for (const sep of Array.from(separators)) {
            if (!sep || typeof sep.getAttribute !== 'function') {
                continue;
            }
            const rawIndex = sep.getAttribute('data-expand-index');
            if (!rawIndex) {
                continue;
            }
            const hunkIndex = Number.parseInt(rawIndex, 10);
            if (Number.isNaN(hunkIndex)) {
                continue;
            }

            const isContentSeparator = Boolean(sep.closest('[data-content]'));
            if (!isContentSeparator) {
                continue;
            }

            const region = this.host.getExpandedHunk(hunkIndex) ?? {
                fromStart: 0,
                fromEnd: 0,
            };
            const gap = getHunkGapLineRanges(fileDiff, hunkIndex, region);
            if (gap.remaining <= 0) {
                const existing = sep.querySelector('.jj-hunk-seam');
                if (existing) {
                    existing.remove();
                }
                continue;
            }

            const isDeletions = Boolean(sep.closest('[data-deletions]'));
            const isAdditions = Boolean(sep.closest('[data-additions]'));
            const isUnified = diffStyle === 'unified' || (!isDeletions && !isAdditions);

            const targets = computeAstBlockTargets(fileDiff, hunkIndex, region, blocks, previewLines);

            this.renderCustomSeamBar({
                container: sep,
                hunkIndex,
                diffStyle,
                isDeletions,
                isAdditions,
                isUnified,
                gap,
                targets,
            });
        }
    }

    createDragEdge(edge: 'top' | 'bottom'): HTMLElement {
        const el = document.createElement('div');
        el.className = `seam-drag-edge ${edge}-edge`;
        el.setAttribute('data-edge', edge);
        el.title =
            edge === 'top' ? 'Drag down to expand lines above the fold' : 'Drag up to expand lines below the fold';
        return el;
    }

    renderCustomSeamBar(opts: {
        container: HTMLElement;
        hunkIndex: number;
        diffStyle: 'split' | 'unified';
        isDeletions: boolean;
        isAdditions: boolean;
        isUnified: boolean;
        gap: HunkGapLineRanges;
        targets: AstBlockTargets;
    }): HTMLElement {
        const { container, hunkIndex, isDeletions, isAdditions, isUnified, gap, targets } = opts;

        let seam = container.querySelector<HTMLElement>('.jj-hunk-seam');
        if (!seam) {
            seam = document.createElement('div');
            seam.className = 'jj-hunk-seam';
            // Stop propagation on pointerdown and click on the recessed seam bar so it never bubbles to Pierre's InteractionManager
            seam.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
            });
            seam.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            container.appendChild(seam);
        }

        seam.replaceChildren();

        if (isUnified) {
            seam.className = 'combo-seam jj-hunk-seam';
            const mainRow = document.createElement('div');
            mainRow.className = 'seam-main-row';

            const cluster = this.createClusterFragment(hunkIndex, gap.remaining, targets);

            mainRow.append(cluster);
            seam.append(this.createDragEdge('top'), mainRow, this.createDragEdge('bottom'));
            this.bindSeamEvents(seam, hunkIndex, targets);
        } else if (isDeletions) {
            seam.className = 'combo-seam-half deletions-half jj-hunk-seam';
            seam.append(this.createDragEdge('top'), this.createDragEdge('bottom'));
            this.bindDragEdgeEvents(seam, hunkIndex);
        } else if (isAdditions) {
            seam.className = 'combo-seam-half additions-half jj-hunk-seam';
            const mainRow = document.createElement('div');
            mainRow.className = 'seam-main-row-half seam-main-right';

            const cluster = this.createClusterFragment(hunkIndex, gap.remaining, targets);
            cluster.classList.add('seam-straddle');

            mainRow.append(cluster);
            seam.append(this.createDragEdge('top'), mainRow, this.createDragEdge('bottom'));
            this.bindSeamEvents(seam, hunkIndex, targets);
        }

        return seam;
    }

    createClusterFragment(hunkIndex: number, remaining: number, targets: AstBlockTargets): HTMLElement {
        const cluster = document.createElement('div');
        cluster.className = 'seam-center-cluster';

        const fileDiff = this.host.getRenderedDiff();
        const hunksCount = fileDiff?.hunks?.length ?? 0;
        const canExpandAbove = hunkIndex > 0;
        const canExpandBelow = hunkIndex < hunksCount;

        if (canExpandAbove) {
            const dockGroup = document.createElement('div');
            dockGroup.className = 'dock-pair-group ast-pill-anchor';

            const topDock = document.createElement('div');
            topDock.className = 'dock-pair dock-top';

            const stepBtn = document.createElement('button');
            stepBtn.type = 'button';
            stepBtn.className = 'seam-pill';
            stepBtn.setAttribute('data-role', 'step-down');
            stepBtn.setAttribute('data-expand-button', '');
            stepBtn.setAttribute('data-expand-up', '');
            stepBtn.title = `Expand +${Math.min(10, remaining)} lines above the fold`;
            stepBtn.appendChild(createSvgIcon('arrowDown'));
            const stepText = document.createElement('span');
            stepText.textContent = '+10';
            stepBtn.appendChild(stepText);
            topDock.appendChild(stepBtn);

            const below = targets.below;
            if (below) {
                const { astBtn, tooltip } = this.createAstBlockElements('below', below);
                topDock.appendChild(astBtn);
                dockGroup.append(topDock, tooltip);
            } else {
                dockGroup.appendChild(topDock);
            }
            cluster.appendChild(dockGroup);
        }

        const middleBtn = document.createElement('button');
        middleBtn.type = 'button';
        middleBtn.className = 'seam-pill pill-all';
        middleBtn.setAttribute('data-role', 'expand-all');
        middleBtn.setAttribute('data-expand-button', '');
        middleBtn.setAttribute('data-expand-all-button', '');
        middleBtn.title = `Click to expand all ${remaining} lines, or drag down/up to peel`;
        middleBtn.appendChild(createSvgIcon('gripDots'));
        middleBtn.appendChild(createSvgIcon('unfold'));
        const middleText = document.createElement('span');
        middleText.textContent = `+${remaining} lines`;
        middleBtn.appendChild(middleText);
        cluster.appendChild(middleBtn);

        if (canExpandBelow) {
            const dockGroup = document.createElement('div');
            dockGroup.className = 'dock-pair-group ast-pill-anchor';

            const bottomDock = document.createElement('div');
            bottomDock.className = 'dock-pair dock-bottom';

            const stepBtn = document.createElement('button');
            stepBtn.type = 'button';
            stepBtn.className = 'seam-pill';
            stepBtn.setAttribute('data-role', 'step-up');
            stepBtn.setAttribute('data-expand-button', '');
            stepBtn.setAttribute('data-expand-down', '');
            stepBtn.title = `Expand +${Math.min(10, remaining)} lines below the fold`;
            stepBtn.appendChild(createSvgIcon('arrowUp'));
            const stepText = document.createElement('span');
            stepText.textContent = '+10';
            stepBtn.appendChild(stepText);
            bottomDock.appendChild(stepBtn);

            const above = targets.above;
            if (above) {
                const { astBtn, tooltip } = this.createAstBlockElements('above', above);
                bottomDock.appendChild(astBtn);
                dockGroup.append(bottomDock, tooltip);
            } else {
                dockGroup.appendChild(bottomDock);
            }
            cluster.appendChild(dockGroup);
        }

        return cluster;
    }

    createAstBlockElements(
        direction: 'above' | 'below',
        target: AstBlockTarget,
    ): {
        astBtn: HTMLButtonElement;
        tooltip: HTMLElement;
    } {
        const astBtn = document.createElement('button');
        astBtn.type = 'button';
        astBtn.className = 'seam-pill pill-ast';
        astBtn.setAttribute('data-role', direction === 'below' ? 'ast-down' : 'ast-up');
        astBtn.title =
            direction === 'below'
                ? 'Progressive +Block (hover for AST path, click to expand to end of block)'
                : 'Progressive +Block (hover for AST path, click to expand to start of block)';
        astBtn.appendChild(createSvgIcon('braces'));

        const astLabel = document.createElement('span');
        astLabel.append('+Block (');
        const token = document.createElement('span');
        token.className = 'ast-fn-token';
        token.textContent = target.block.name;
        astLabel.appendChild(token);
        astLabel.append(` · +${target.count})`);
        astBtn.appendChild(astLabel);

        const tooltip = document.createElement('div');
        tooltip.className = `ast-tooltip tooltip-${direction}`;
        tooltip.setAttribute('role', 'tooltip');

        const header = document.createElement('div');
        header.className = 'ast-tooltip-header';
        const h1 = document.createElement('span');
        h1.className = 'tt-badge';
        h1.textContent = `${direction === 'below' ? 'BLOCK_BELOW' : 'BLOCK_ABOVE'} (ref L${target.refLine} → L${target.targetLine})`;
        const h2 = document.createElement('span');
        h2.className = 'tt-badge';
        h2.textContent = `+${target.count} lines`;
        header.append(h1, h2);

        const pathDiv = document.createElement('div');
        pathDiv.className = 'ast-tooltip-path';
        target.path.forEach((p, idx) => {
            if (idx > 0) {
                pathDiv.appendChild(createSvgIcon('chevronRight'));
            }
            const span = document.createElement('span');
            span.textContent = p.name;
            pathDiv.appendChild(span);
        });

        const codeDiv = document.createElement('div');
        codeDiv.className = 'ast-tooltip-code tt-preview';
        codeDiv.textContent = `L${target.targetLine}: ${target.codePreview}`;

        tooltip.append(header, pathDiv, codeDiv);
        return { astBtn, tooltip };
    }

    bindDragEdgeEvents(seam: HTMLElement, hunkIndex: number): void {
        const topEdge = seam.querySelector<HTMLElement>('[data-edge="top"]');
        if (topEdge) {
            topEdge.addEventListener('pointerdown', (e) =>
                startSeamInteraction({
                    event: e,
                    hunkIndex,
                    host: this.host,
                    getLineHeightPx: () => this.getRenderedLineHeight(),
                }),
            );
        }
        const bottomEdge = seam.querySelector<HTMLElement>('[data-edge="bottom"]');
        if (bottomEdge) {
            bottomEdge.addEventListener('pointerdown', (e) =>
                startSeamInteraction({
                    event: e,
                    hunkIndex,
                    host: this.host,
                    getLineHeightPx: () => this.getRenderedLineHeight(),
                }),
            );
        }
    }

    bindSeamEvents(seam: HTMLElement, hunkIndex: number, targets: AstBlockTargets): void {
        this.bindDragEdgeEvents(seam, hunkIndex);

        const btnStepDown = seam.querySelector<HTMLButtonElement>('[data-role="step-down"]');
        if (btnStepDown) {
            btnStepDown.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const diff = this.host.getRenderedDiff();
                const region = this.host.getExpandedHunk(hunkIndex) ?? {
                    fromStart: 0,
                    fromEnd: 0,
                };
                const gap = getHunkGapLineRanges(diff, hunkIndex, region);
                const count = clampExpansionLines(10, gap.remaining);
                this.host.expandHunk(hunkIndex, 'up', count);
            });
        }

        const btnAstDown = seam.querySelector<HTMLButtonElement>('[data-role="ast-down"]');
        if (btnAstDown && targets.below) {
            const belowTarget = targets.below;
            btnAstDown.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.host.expandHunk(hunkIndex, 'up', belowTarget.count);
            });
        }

        const btnExpandAll = seam.querySelector<HTMLButtonElement>('[data-role="expand-all"]');
        if (btnExpandAll) {
            btnExpandAll.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
            btnExpandAll.addEventListener('pointerdown', (e) =>
                startSeamInteraction({
                    event: e,
                    hunkIndex,
                    host: this.host,
                    clickActionFn: () => {
                        this.host.expandHunk(hunkIndex, 'both', Number.POSITIVE_INFINITY);
                    },
                    getLineHeightPx: () => this.getRenderedLineHeight(),
                }),
            );
        }

        const btnStepUp = seam.querySelector<HTMLButtonElement>('[data-role="step-up"]');
        if (btnStepUp) {
            btnStepUp.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const diff = this.host.getRenderedDiff();
                const region = this.host.getExpandedHunk(hunkIndex) ?? {
                    fromStart: 0,
                    fromEnd: 0,
                };
                const gap = getHunkGapLineRanges(diff, hunkIndex, region);
                const count = clampExpansionLines(10, gap.remaining);
                this.host.expandHunk(hunkIndex, 'down', count);
            });
        }

        const btnAstUp = seam.querySelector<HTMLButtonElement>('[data-role="ast-up"]');
        if (btnAstUp && targets.above) {
            const aboveTarget = targets.above;
            btnAstUp.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.host.expandHunk(hunkIndex, 'down', aboveTarget.count);
            });
        }
    }
}

/**
 * Subclass of @pierre/diffs FileDiff that integrates interactive hunk expansion.
 */
export class JjFileDiff<LAnnotation = undefined, Caret = undefined>
    extends FileDiff<LAnnotation, Caret>
    implements HunkExpansionControllerHost
{
    readonly hunkExpansionController: HunkExpansionController = new HunkExpansionController(this);
    preloadFullContents?: () => Promise<void>;

    getDiffStyle(): 'split' | 'unified' {
        return this.options.diffStyle ?? 'split';
    }

    getContainer(): HTMLElement | ShadowRoot | ParentNode | null | undefined {
        return this.fileContainer?.shadowRoot ?? this.fileContainer;
    }

    getShadowRoot(): HTMLElement | ShadowRoot | ParentNode | null | undefined {
        return this.fileContainer?.shadowRoot ?? this.fileContainer;
    }

    override getRenderedDiff(): FileDiffMetadata | undefined {
        return super.getRenderedDiff();
    }

    getExpandedHunk(hunkIndex: number): ExpandedHunkRegion | undefined {
        return this.hunksRenderer?.getExpandedHunk(hunkIndex);
    }

    override expandHunk = (
        hunkIndex: number,
        direction: ExpansionDirections,
        expansionLineCountOverride?: number,
    ): void => {
        const diff = this.getRenderedDiff();
        let effectiveCount = expansionLineCountOverride;
        if (
            diff &&
            direction !== 'both' &&
            expansionLineCountOverride !== Number.POSITIVE_INFINITY &&
            expansionLineCountOverride !== undefined
        ) {
            const region = this.getExpandedHunk(hunkIndex) ?? {
                fromStart: 0,
                fromEnd: 0,
            };
            const gap = getHunkGapLineRanges(diff, hunkIndex, region);
            effectiveCount = clampExpansionLines(expansionLineCountOverride, gap.remaining);
        } else if (diff && direction !== 'both' && expansionLineCountOverride === undefined) {
            const region = this.getExpandedHunk(hunkIndex) ?? {
                fromStart: 0,
                fromEnd: 0,
            };
            const gap = getHunkGapLineRanges(diff, hunkIndex, region);
            const defaultLines = this.options.expansionLineCount ?? 10;
            effectiveCount = clampExpansionLines(defaultLines, gap.remaining);
        }

        if (this.preloadFullContents && diff?.isPartial) {
            void this.preloadFullContents();
        }

        this.loadFilesIfNecessary();
        this.hunksRenderer?.expandHunk(hunkIndex, direction, effectiveCount);
        this.rerender();
    };

    enhanceHunkSeparators(): void {
        this.hunkExpansionController.enhanceSeparators();
    }

    override finalizeRender(): void {
        super.finalizeRender();
        this.hunkExpansionController.enhanceSeparators();
    }

    override onThemeChange(): void {
        super.onThemeChange();
        this.hunkExpansionController.enhanceSeparators();
    }

    override cleanUp(recycle?: boolean): void {
        super.cleanUp(recycle);
        this.hunkExpansionController.resetCache();
    }

    resetForNewDiff(): void {
        this.pendingFiles = undefined;
        this.hunksRenderer?.getExpandedHunksMap().clear();
        this.hunksRenderer?.clearRenderCache();
        this.hunkExpansionController.resetCache();
    }

    protected override async handleFilesLoaded(
        expectedDiff: FileDiffMetadata,
        files: Awaited<ReturnType<NonNullable<FileDiff<LAnnotation, Caret>['options']['loadDiffFiles']>>>,
    ): Promise<void> {
        await super.handleFilesLoaded(expectedDiff, files);
        this.hunkExpansionController.enhanceSeparators();
    }
}

// CodeView integration helper for PierreMultiDiffViewer
interface RendererWithHunks {
    hunksRenderer: {
        getExpandedHunk(hunkIndex: number): ExpandedHunkRegion | undefined;
        expandHunk(hunkIndex: number, direction: ExpansionDirections, count?: number): void;
    };
}

function hasHunksRenderer(obj: unknown): obj is RendererWithHunks {
    if (typeof obj !== 'object' || obj === null || !('hunksRenderer' in obj)) {
        return false;
    }
    const target = obj.hunksRenderer;
    if (typeof target !== 'object' || target === null) {
        return false;
    }
    return 'getExpandedHunk' in target && typeof target.getExpandedHunk === 'function';
}

interface HasRenderedDiff {
    getRenderedDiff(): FileDiffMetadata | undefined;
}

function hasRenderedDiff(obj: unknown): obj is HasRenderedDiff {
    if (typeof obj !== 'object' || obj === null) {
        return false;
    }
    return 'getRenderedDiff' in obj && typeof obj.getRenderedDiff === 'function';
}

interface HasDiffOptions {
    options: {
        diffStyle?: 'split' | 'unified';
        expansionLineCount?: number;
    };
}

function hasDiffOptions(obj: unknown): obj is HasDiffOptions {
    if (typeof obj !== 'object' || obj === null || !('options' in obj)) {
        return false;
    }
    const opts = obj.options;
    return typeof opts === 'object' && opts !== null;
}

interface HasExpandHunk {
    expandHunk(hunkIndex: number, direction: ExpansionDirections, count?: number): void;
}

function hasExpandHunk(obj: unknown): obj is HasExpandHunk {
    if (typeof obj !== 'object' || obj === null) {
        return false;
    }
    return 'expandHunk' in obj && typeof obj.expandHunk === 'function';
}

interface CodeViewDiffItemContextShape {
    type: 'diff';
    item: {
        fileDiff?: FileDiffMetadata;
    };
    instance: unknown;
}

function isCodeViewDiffItem(obj: unknown): obj is CodeViewDiffItemContextShape {
    if (typeof obj !== 'object' || obj === null) {
        return false;
    }
    return 'type' in obj && obj.type === 'diff' && 'item' in obj && typeof obj.item === 'object' && obj.item !== null;
}

export class CodeViewItemControllerHost implements HunkExpansionControllerHost {
    private readonly fallbackExpansions = new Map<number, ExpandedHunkRegion>();
    private controller?: HunkExpansionController;

    constructor(
        private readonly containerNode: HTMLElement,
        private diffItem: CodeViewDiffItemContextShape,
    ) {}

    setController(controller: HunkExpansionController): void {
        this.controller = controller;
    }

    updateDiffItem(diffItem: CodeViewDiffItemContextShape): void {
        if (diffItem.item.fileDiff !== this.diffItem.item.fileDiff) {
            this.fallbackExpansions.clear();
        }
        this.diffItem = diffItem;
    }

    getRenderedDiff(): FileDiffMetadata | undefined {
        const inst = this.diffItem.instance;
        if (hasRenderedDiff(inst)) {
            return inst.getRenderedDiff() ?? this.diffItem.item.fileDiff;
        }
        return this.diffItem.item.fileDiff;
    }

    getExpandedHunk(hunkIndex: number): ExpandedHunkRegion | undefined {
        const inst = this.diffItem.instance;
        const rendererVal = hasHunksRenderer(inst) ? inst.hunksRenderer.getExpandedHunk(hunkIndex) : undefined;
        const fallbackVal = this.fallbackExpansions.get(hunkIndex);
        if (!rendererVal && !fallbackVal) {
            return undefined;
        }
        return {
            fromStart: Math.max(rendererVal?.fromStart ?? 0, fallbackVal?.fromStart ?? 0),
            fromEnd: Math.max(rendererVal?.fromEnd ?? 0, fallbackVal?.fromEnd ?? 0),
        };
    }

    expandHunk(hunkIndex: number, direction: 'up' | 'down' | 'both', expansionLineCountOverride?: number): void {
        const diff = this.getRenderedDiff();
        let effectiveCount = expansionLineCountOverride;
        let gapRemaining = 10;
        let gapRangeSize = 10;
        if (diff) {
            const region = this.getExpandedHunk(hunkIndex) ?? {
                fromStart: 0,
                fromEnd: 0,
            };
            const gap = getHunkGapLineRanges(diff, hunkIndex, region);
            gapRemaining = gap.remaining;
            gapRangeSize = gap.rangeSize;
            if (direction !== 'both' && expansionLineCountOverride !== Number.POSITIVE_INFINITY) {
                const defaultCount = expansionLineCountOverride ?? 10;
                effectiveCount = clampExpansionLines(defaultCount, gap.remaining);
            }
        }

        const current = this.fallbackExpansions.get(hunkIndex) ?? {
            fromStart: 0,
            fromEnd: 0,
        };
        const count = effectiveCount ?? gapRemaining;
        if (direction === 'up' || direction === 'both') {
            current.fromStart = Math.min(gapRangeSize, current.fromStart + count);
        }
        if (direction === 'down' || direction === 'both') {
            current.fromEnd = Math.min(gapRangeSize, current.fromEnd + count);
        }
        this.fallbackExpansions.set(hunkIndex, current);

        const inst = this.diffItem.instance;
        if (hasExpandHunk(inst)) {
            inst.expandHunk(hunkIndex, direction, effectiveCount);
        }
        this.controller?.enhanceSeparators();
    }

    getDiffStyle(): 'split' | 'unified' {
        const inst = this.diffItem.instance;
        if (hasDiffOptions(inst)) {
            return inst.options.diffStyle ?? 'split';
        }
        return 'split';
    }

    getContainer(): HTMLElement | ShadowRoot {
        const diffsEl = this.containerNode.querySelector('diffs-container');
        return diffsEl?.shadowRoot ?? this.containerNode.shadowRoot ?? this.containerNode;
    }

    getShadowRoot(): HTMLElement | ShadowRoot | null {
        const diffsEl = this.containerNode.querySelector('diffs-container');
        return diffsEl?.shadowRoot ?? this.containerNode.shadowRoot ?? this.containerNode;
    }
}

interface CodeViewControllerEntry {
    host: CodeViewItemControllerHost;
    controller: HunkExpansionController;
}

const codeViewControllers = new WeakMap<HTMLElement, CodeViewControllerEntry>();

export function enhanceCodeViewDiffItemSeparators(node: HTMLElement, renderedItem: unknown): void {
    if (!isCodeViewDiffItem(renderedItem)) {
        syncHostColumnNumberWidth(node, true);
        return;
    }
    let entry = codeViewControllers.get(node);
    if (!entry) {
        const host = new CodeViewItemControllerHost(node, renderedItem);
        const controller = new HunkExpansionController(host);
        host.setController(controller);
        entry = { host, controller };
        codeViewControllers.set(node, entry);
    } else {
        entry.host.updateDiffItem(renderedItem);
    }
    entry.controller.enhanceSeparators();
}
