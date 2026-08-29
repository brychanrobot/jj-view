/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared layout constants for the CommitGraph webview.
 * Centralizing these ensures that the SVG graph and the HTML text rows
 * stay perfectly synchronized in height and horizontal positioning.
 */

export const LANE_WIDTH = 16;
export const ROW_HEIGHT_NORMAL = 28;
export const ROW_HEIGHT_EXPANDED = 44;
export const ROW_HEIGHT_ELISION = 10;
export const LEFT_MARGIN = 12;
export const COMMIT_ROW_PADDING_LEFT = 6;

// Derived constants
export const LANE_CENTER_X = LANE_WIDTH / 2;
export const ROW_CENTER_Y = ROW_HEIGHT_NORMAL / 2;
