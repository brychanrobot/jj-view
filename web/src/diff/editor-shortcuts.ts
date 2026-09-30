/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface EditorShortcutHandlers {
    isWorkingCopy?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    onSave?: () => Promise<void> | void;
    onUndo?: () => void;
    onRedo?: () => void;
    onEscape?: () => void;
}

/**
 * Handles common editor keyboard shortcuts (Save, Undo, Redo, Escape) across Pierre viewers.
 */
export function handleEditorKeyDown(e: KeyboardEvent, handlers: EditorShortcutHandlers): void {
    if (e.key === 'Escape') {
        handlers.onEscape?.();
        return;
    }

    if (!handlers.isWorkingCopy) {
        return;
    }

    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
    }

    const modKey = e.ctrlKey || e.metaKey;

    if (modKey && (e.key === 's' || e.key === 'S')) {
        if (handlers.onSave) {
            e.preventDefault();
            void handlers.onSave();
        }
        return;
    }

    if (modKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        if (handlers.canUndo && handlers.onUndo) {
            e.preventDefault();
            handlers.onUndo();
        }
        return;
    }

    if ((modKey && (e.key === 'y' || e.key === 'Y')) || (modKey && e.shiftKey && (e.key === 'z' || e.key === 'Z'))) {
        if (handlers.canRedo && handlers.onRedo) {
            e.preventDefault();
            handlers.onRedo();
        }
        return;
    }
}
