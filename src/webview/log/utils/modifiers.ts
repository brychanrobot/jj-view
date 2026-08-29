/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Modifier } from '@dnd-kit/core';

// Custom modifier to snap the left edge of the preview to the cursor
export const snapToCursorLeft: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
    if (!draggingNodeRect || !activatorEvent) {
        return transform;
    }

    const activator = activatorEvent as TouchEvent | MouseEvent;
    const cursorX = 'touches' in activator ? (activator.touches[0]?.clientX ?? 0) : (activator as MouseEvent).clientX;
    const cursorY = 'touches' in activator ? (activator.touches[0]?.clientY ?? 0) : (activator as MouseEvent).clientY;

    // Initial element position
    const initialX = draggingNodeRect.left;
    const initialY = draggingNodeRect.top;

    // Logic:
    // TargetPos = (InitialCursor + Delta) + Offset
    // ActualPos = InitialElement + ReturnDelta
    // -> ReturnDelta = Delta + InitialCursor - InitialElement + Offset

    const xOffset = -5; // Align left edge (handle) with cursor
    const yOffset = -draggingNodeRect.height / 2; // Vertically center card on cursor

    return {
        ...transform,
        x: transform.x + cursorX - initialX + xOffset,
        y: transform.y + cursorY - initialY + yOffset,
    };
};
