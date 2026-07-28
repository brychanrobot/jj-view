/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as React from 'react';
import type { PressedKeysState } from '../utils/drag-modifiers';
import { resolveActiveModifier } from '../utils/drag-modifiers';

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
    // Ignore keydown action shortcuts if the user is typing in an editable field
    if (isPressed && isEditableElement(e.target)) {
        return null;
    }

    if (e.key === 'Shift') {
        return 'shift';
    }

    // Ignore single-character action shortcuts if combined with Ctrl, Cmd/Meta, or Alt
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

export function useDragModifiers() {
    const [pressedKeys, setPressedKeys] = React.useState<PressedKeysState>(initialKeys);

    const resetKeys = React.useCallback(() => {
        setPressedKeys(initialKeys);
    }, []);

    React.useEffect(() => {
        const handleKeyEvent = (e: KeyboardEvent, isPressed: boolean) => {
            const prop = getPressedKeyProperty(e, isPressed);
            if (!prop) {
                return;
            }

            setPressedKeys((prev) => {
                if (prev[prop] === isPressed) {
                    return prev;
                }
                return { ...prev, [prop]: isPressed };
            });
        };

        const handleKeyDown = (e: KeyboardEvent) => handleKeyEvent(e, true);
        const handleKeyUp = (e: KeyboardEvent) => handleKeyEvent(e, false);

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', resetKeys);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', resetKeys);
        };
    }, [resetKeys]);

    const activeModifier = React.useMemo(() => resolveActiveModifier(pressedKeys), [pressedKeys]);

    return {
        pressedKeys,
        activeModifier,
        resetKeys,
    };
}
