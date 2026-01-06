// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Modifier } from '@dnd-kit/core';

// Custom modifier to snap the left edge of the preview to the cursor
export const snapToCursorLeft: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
    if (draggingNodeRect && activatorEvent) {
        const activator = activatorEvent as TouchEvent | MouseEvent;
        const cursorX = 'touches' in activator ? activator.touches[0].clientX : (activator as MouseEvent).clientX;
        const cursorY = 'touches' in activator ? activator.touches[0].clientY : (activator as MouseEvent).clientY;

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
    }

    return transform;
};
