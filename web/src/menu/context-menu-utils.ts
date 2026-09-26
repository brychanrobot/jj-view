/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContextNodeLike {
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    parentElement: ContextNodeLike | null;
}

/**
 * Extracts and merges VS Code context data from DOM elements matching `data-vscode-context`.
 * Traverses from the target element up the DOM hierarchy to `document.body`, collecting
 * attributes and merging them from outermost ancestor to innermost target element, so that
 * child properties override parent properties while preserving parent context.
 */
export function extractVsCodeContext(target: ContextNodeLike | null): Record<string, unknown> | null {
    if (!target) {
        return null;
    }

    const contextNodes: ContextNodeLike[] = [];
    let current: ContextNodeLike | null = target;

    const body: ContextNodeLike | null = typeof document !== 'undefined' ? document.body : null;
    const docEl: ContextNodeLike | null = typeof document !== 'undefined' ? document.documentElement : null;

    while (current && current !== body && current !== docEl) {
        if (typeof current.hasAttribute === 'function' && current.hasAttribute('data-vscode-context')) {
            contextNodes.push(current);
        }
        current = current.parentElement;
    }

    if (contextNodes.length === 0) {
        return null;
    }

    let merged: Record<string, unknown> = {};

    // Merge from root-most ancestor to deepest target node
    for (let i = contextNodes.length - 1; i >= 0; i--) {
        const raw = contextNodes[i].getAttribute('data-vscode-context');
        if (!raw) {
            continue;
        }

        try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                merged = { ...merged, ...(parsed as Record<string, unknown>) };
            }
        } catch (_) {
            // Ignore malformed JSON attributes
        }
    }

    return Object.keys(merged).length > 0 ? merged : null;
}
