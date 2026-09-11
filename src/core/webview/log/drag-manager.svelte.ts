/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommitDragData } from './components/CommitDragPreview';
import { type DragActionModifier, type PressedKeysState, resolveActiveModifier } from './utils/drag-modifiers';

export type DragItem = { type: 'bookmark'; name: string; remote?: string } | (CommitDragData & { type: 'commit' });

export interface DropTarget {
    type: 'commit';
    changeId: string;
}

const initialKeys: PressedKeysState = {
    r: false,
    shift: false,
    s: false,
    d: false,
    m: false,
};

function isEditableElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return true;
    }
    return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

function getPressedKeyProperty(e: KeyboardEvent, isPressed: boolean): keyof PressedKeysState | null {
    if (isPressed && isEditableElement(e.target)) {
        return null;
    }
    if (e.key === 'Shift') {
        return 'shift';
    }
    if (isPressed && (e.ctrlKey || e.metaKey || e.altKey)) {
        return null;
    }
    const lower = e.key.toLowerCase();
    if (lower === 'r') {
        return 'r';
    }
    if (lower === 's') {
        return 's';
    }
    if (lower === 'd') {
        return 'd';
    }
    if (lower === 'm') {
        return 'm';
    }
    return null;
}

export class DragManager {
    activeDragItem = $state<DragItem | null>(null);
    activeDropTarget = $state<DropTarget | null>(null);
    pointerPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
    pressedKeys = $state<PressedKeysState>({ ...initialKeys });

    isDragging = $derived(this.activeDragItem !== null);
    activeModifier = $derived<DragActionModifier>(resolveActiveModifier(this.pressedKeys));

    private onDropCallback?: (item: DragItem, target: DropTarget, modifier: DragActionModifier) => void;

    constructor(onDrop?: (item: DragItem, target: DropTarget, modifier: DragActionModifier) => void) {
        this.onDropCallback = onDrop;
    }

    setOnDrop(onDrop: (item: DragItem, target: DropTarget, modifier: DragActionModifier) => void) {
        this.onDropCallback = onDrop;
    }

    resetKeys() {
        this.pressedKeys = { ...initialKeys };
    }

    handleKeyDown = (e: KeyboardEvent) => {
        const prop = getPressedKeyProperty(e, true);
        if (prop && !this.pressedKeys[prop]) {
            this.pressedKeys[prop] = true;
        }
    };

    handleKeyUp = (e: KeyboardEvent) => {
        const prop = getPressedKeyProperty(e, false);
        if (prop && this.pressedKeys[prop]) {
            this.pressedKeys[prop] = false;
        }
    };

    handleWindowBlur = () => {
        this.resetKeys();
    };

    draggable = (node: HTMLElement, getItem: () => DragItem | null) => {
        let startX = 0;
        let startY = 0;
        let isTracking = false;
        let hasMovedPastThreshold = false;

        const handlePointerMove = (e: PointerEvent) => {
            if (!isTracking) {
                return;
            }

            if (!hasMovedPastThreshold) {
                const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
                if (dist < 5) {
                    return;
                }

                const item = getItem();
                if (!item) {
                    cleanup();
                    return;
                }
                hasMovedPastThreshold = true;
                this.activeDragItem = item;
            }

            this.pointerPos = { x: e.clientX, y: e.clientY };

            const el = document.elementFromPoint(e.clientX, e.clientY);
            const dropEl = el?.closest('[data-drop-change-id]');
            if (dropEl) {
                const changeId = dropEl.getAttribute('data-drop-change-id');
                if (changeId) {
                    this.activeDropTarget = { type: 'commit', changeId };
                } else {
                    this.activeDropTarget = null;
                }
            } else {
                this.activeDropTarget = null;
            }
        };

        const handlePointerUp = () => {
            if (hasMovedPastThreshold && this.activeDragItem && this.activeDropTarget) {
                this.onDropCallback?.(this.activeDragItem, this.activeDropTarget, this.activeModifier);
            }
            cleanup();
        };

        const handlePointerCancel = () => {
            cleanup();
        };

        const cleanup = () => {
            isTracking = false;
            hasMovedPastThreshold = false;
            this.activeDragItem = null;
            this.activeDropTarget = null;
            this.resetKeys();
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerCancel);
        };

        const handlePointerDown = (e: PointerEvent) => {
            if (e.button !== 0) {
                return;
            }
            const target = e.target as HTMLElement | null;
            if (target?.closest('button, a, input, textarea, select')) {
                return;
            }
            const nearestDraggable = target?.closest('[data-draggable="true"]');
            if (nearestDraggable && nearestDraggable !== node) {
                return;
            }

            const item = getItem();
            if (!item) {
                return;
            }

            startX = e.clientX;
            startY = e.clientY;
            isTracking = true;
            hasMovedPastThreshold = false;

            window.addEventListener('pointermove', handlePointerMove);
            window.addEventListener('pointerup', handlePointerUp);
            window.addEventListener('pointercancel', handlePointerCancel);
        };

        node.setAttribute('data-draggable', 'true');
        node.addEventListener('pointerdown', handlePointerDown);

        return {
            destroy() {
                node.removeEventListener('pointerdown', handlePointerDown);
                cleanup();
            },
        };
    };

    droppable = (node: HTMLElement, getChangeId: () => string) => {
        const update = () => {
            const changeId = getChangeId();
            node.setAttribute('data-drop-change-id', changeId);
        };

        update();

        return {
            update,
            destroy() {
                node.removeAttribute('data-drop-change-id');
            },
        };
    };
}
