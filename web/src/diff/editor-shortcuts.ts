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
    onAddSelectionToChat?: () => Promise<void> | void;
}

interface ShortcutTargetLike {
    tagName?: string;
    closest?: (selector: string) => unknown;
}

function isEditableInputTarget(e: KeyboardEvent): boolean {
    const composedFirst = typeof e.composedPath === 'function' ? e.composedPath()[0] : undefined;
    const rawTarget = (composedFirst ?? e.target) as ShortcutTargetLike | null | undefined;
    if (!rawTarget) {
        return false;
    }
    if (rawTarget.tagName === 'INPUT' || rawTarget.tagName === 'TEXTAREA') {
        return true;
    }
    if (typeof rawTarget.closest === 'function' && rawTarget.closest('[data-testid="quick-input-widget"]')) {
        return true;
    }
    return false;
}

/**
 * Handles common editor keyboard shortcuts (Save, Undo, Redo, Escape, Add Selection to Chat) across Pierre viewers.
 */
export function handleEditorKeyDown(e: KeyboardEvent, handlers: EditorShortcutHandlers): void {
    if (isEditableInputTarget(e)) {
        return;
    }

    if (e.key === 'Escape') {
        handlers.onEscape?.();
        return;
    }

    const modKey = e.ctrlKey || e.metaKey;

    if (modKey && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L' || e.key === 'i' || e.key === 'I')) {
        if (handlers.onAddSelectionToChat) {
            e.preventDefault();
            void handlers.onAddSelectionToChat();
        }
        return;
    }

    if (!handlers.isWorkingCopy) {
        return;
    }

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
