/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SinonStub } from 'sinon';
import type * as vscode from 'vscode';

export /**
 * Creates a partial mock of type T.
 * Use this to mock interfaces/classes without implementing every property.
 */
function createMock<T>(partial: Partial<T> = {}): T {
    return partial as unknown as T;
}

export function asSinonStub(fn: unknown): SinonStub {
    return fn as SinonStub;
}

export function accessPrivate<T = unknown>(obj: object, key: string): T {
    return (obj as Record<string, T>)[key];
}

export function setPrivate(obj: object, key: string, value: unknown): void {
    (obj as Record<string, unknown>)[key] = value;
}

export function exposePrivate<T>(obj: object): T {
    return obj as unknown as T;
}

export function createMockLogOutputChannel(partial: Partial<vscode.LogOutputChannel> = {}): vscode.LogOutputChannel {
    const mockFn = (): (() => unknown) => {
        if (typeof globalThis !== 'undefined' && 'vi' in globalThis) {
            return (globalThis as unknown as { vi: { fn: () => () => unknown } }).vi.fn();
        }
        return () => {};
    };

    const onDidChangeLogLevelMock = mockFn();
    if (typeof onDidChangeLogLevelMock === 'function' && 'mockReturnValue' in onDidChangeLogLevelMock) {
        (onDidChangeLogLevelMock as unknown as { mockReturnValue: (val: unknown) => void }).mockReturnValue({
            dispose: () => {},
        });
    }

    return {
        name: 'Mock Log Output Channel',
        append: mockFn(),
        appendLine: mockFn(),
        replace: mockFn(),
        clear: mockFn(),
        show: mockFn(),
        hide: mockFn(),
        dispose: mockFn(),
        logLevel: 3, // LogLevel.Info
        onDidChangeLogLevel: onDidChangeLogLevelMock,
        trace: mockFn(),
        debug: mockFn(),
        info: mockFn(),
        warn: mockFn(),
        error: mockFn(),
        ...partial,
    } as unknown as vscode.LogOutputChannel;
}
