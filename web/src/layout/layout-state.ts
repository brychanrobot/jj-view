/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage key for the persisted standalone layout. The value is global (not
 * per repository): panel sizes are a property of the window, and the hub
 * remounts the whole iframe when switching chats, so this is what survives.
 */
export const LAYOUT_STORAGE_KEY = 'jj-view.webLayout';

/** Layout state the user has explicitly chosen. Absent fields mean "automatic". */
export interface PersistedLayout {
    /** Width of the SCM/log sidebar in px. */
    sidebarWidth?: number;
    /**
     * Height of the log pane in px once the user has resized it. While unset
     * the log sizes itself to its content, capped at half the window.
     */
    logHeight?: number;
    /** Whether the log pane is collapsed to its header. */
    logCollapsed?: boolean;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Validates an untrusted stored value; invalid fields fall back to automatic. */
export function parsePersistedLayout(value: unknown): PersistedLayout {
    if (typeof value !== 'object' || value === null) {
        return {};
    }
    const record: Record<string, unknown> = { ...value };
    const layout: PersistedLayout = {};
    if (isFiniteNumber(record.sidebarWidth) && record.sidebarWidth > 0) {
        layout.sidebarWidth = record.sidebarWidth;
    }
    if (isFiniteNumber(record.logHeight) && record.logHeight > 0) {
        layout.logHeight = record.logHeight;
    }
    if (typeof record.logCollapsed === 'boolean') {
        layout.logCollapsed = record.logCollapsed;
    }
    return layout;
}
