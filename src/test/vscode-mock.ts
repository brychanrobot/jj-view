/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

/**
 * Creates a base vscode mock with common properties. Override any property
 * by passing a partial object — properties are shallow-merged per namespace.
 *
 * Usage:
 *   vi.mock('vscode', () => createVscodeMock());
 *   vi.mock('vscode', () => createVscodeMock({ window: { showQuickPick: vi.fn() } }));
 */
export function createVscodeMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const base: Record<string, unknown> = {
        ProgressLocation: { Notification: 15 },
        Uri: { file: (path: string) => ({ fsPath: path }) },
        window: {
            showErrorMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            showWarningMessage: vi.fn(),
            withProgress: vi.fn().mockImplementation(async (_: unknown, task: () => Promise<unknown>) => task()),
            setStatusBarMessage: vi.fn(),
        },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/root' } }],
        },
    };

    // Shallow merge each top-level key so overrides extend rather than replace namespaces
    for (const key of Object.keys(overrides)) {
        const baseVal = base[key];
        const overrideVal = overrides[key];
        if (baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal) &&
            overrideVal && typeof overrideVal === 'object' && !Array.isArray(overrideVal)) {
            base[key] = { ...baseVal as Record<string, unknown>, ...overrideVal as Record<string, unknown> };
        } else {
            base[key] = overrideVal;
        }
    }

    return base;
}
