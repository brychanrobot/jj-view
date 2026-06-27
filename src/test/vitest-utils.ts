/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { vi } from 'vitest';
import type * as vscode from 'vscode';

export function resetMockQuickPick(mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>) {
    mockQuickPick.value = '';
    mockQuickPick.placeholder = '';
    mockQuickPick.matchOnDescription = false;
    mockQuickPick.matchOnDetail = false;

    // Reset properties via mutable cast
    const mutable = mockQuickPick as {
        -readonly [K in keyof vscode.QuickPick<vscode.QuickPickItem>]: vscode.QuickPick<vscode.QuickPickItem>[K];
    };
    mutable.items = [];
    mutable.selectedItems = [];
    mutable.activeItems = [];

    // Reset the mock functions
    (mockQuickPick.show as Mock).mockClear();
    (mockQuickPick.hide as Mock).mockClear();
    (mockQuickPick.dispose as Mock).mockClear();
    (mockQuickPick.onDidAccept as Mock).mockClear();
    (mockQuickPick.onDidHide as Mock).mockClear();
    (mockQuickPick.onDidChangeValue as Mock).mockClear();
}

/**
 * Sets the selectedItems of a mocked QuickPick in a type-safe way.
 */
export function setSelectedItems<T extends vscode.QuickPickItem>(quickPick: vscode.QuickPick<T>, items: readonly T[]) {
    const mutable = quickPick as { -readonly [K in keyof vscode.QuickPick<T>]: vscode.QuickPick<T>[K] };
    mutable.selectedItems = items;
}

/**
 * Sets the activeItems of a mocked QuickPick in a type-safe way.
 */
export function setActiveItems<T extends vscode.QuickPickItem>(quickPick: vscode.QuickPick<T>, items: readonly T[]) {
    const mutable = quickPick as { -readonly [K in keyof vscode.QuickPick<T>]: vscode.QuickPick<T>[K] };
    mutable.activeItems = items;
}

export interface MockQuickPick {
    items: unknown[];
    placeholder: string;
    matchOnDescription: boolean;
    matchOnDetail: boolean;
    value: string;
    selectedItems: unknown[];
    activeItems: unknown[];
    onDidChangeValue: Mock;
    onDidAccept: Mock;
    onDidHide: Mock;
    show: Mock;
    hide: Mock;
    dispose: Mock;
}

export function createMockQuickPick(): MockQuickPick {
    return {
        items: [],
        placeholder: '',
        matchOnDescription: false,
        matchOnDetail: false,
        value: '',
        selectedItems: [],
        activeItems: [],
        onDidChangeValue: vi.fn(),
        onDidAccept: vi.fn(),
        onDidHide: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };
}

export function asMock(fn: unknown): Mock {
    return fn as Mock;
}
