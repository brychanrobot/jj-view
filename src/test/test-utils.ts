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

/**
 * A helper class to simplify waiting for a callback to be invoked and retrieving
 * the arguments passed to it.
 */
export class CallbackWaiter<T = void> {
    private _promise: Promise<T>;
    private _resolve!: (value: T | PromiseLike<T>) => void;
    private _isResolved = false;
    private _resolvedValue?: T;

    constructor() {
        this._promise = new Promise<T>((resolve) => {
            this._resolve = resolve;
        });
    }

    recordCall(value: T): void {
        if (this._isResolved) {
            throw new Error('CallbackWaiter: recordCall was called twice without waitNext/reset.');
        }
        this._resolvedValue = value;
        this._isResolved = true;
        this._resolve(value);
    }

    async get(): Promise<T> {
        if (this._isResolved) {
            return this._resolvedValue as T;
        }
        return this._promise;
    }

    async waitNext(): Promise<T> {
        const val = await this.get();
        this.reset();
        return val;
    }

    reset(): void {
        this._isResolved = false;
        this._resolvedValue = undefined;
        this._promise = new Promise<T>((resolve) => {
            this._resolve = resolve;
        });
    }

    getCallback(): (value: T) => void {
        return (value: T) => this.recordCall(value);
    }
}

/**
 * A stateful fake implementation of configuration for tests without relying on a mocking framework.
 *
 * Example usage:
 * ```ts
 * const config = new FakeConfigStore({
 *     refreshDebounceMillis: 100,
 *     refreshDebounceMaxMultiplier: 4,
 * });
 *
 * // Use with vscode.workspace.getConfiguration mock/fake:
 * getConfigurationMock.mockImplementation(() => config.toWorkspaceConfiguration());
 *
 * // Or pass provider directly to JjService or helpers:
 * const jjService = new JjService({ getConfig: config.provider });
 *
 * // Dynamically update config during tests:
 * config.set('refreshDebounceMillis', 500);
 * ```
 */
export class FakeConfigStore {
    private readonly _store: Map<string, unknown>;

    constructor(initialConfig: Record<string, unknown> = {}) {
        this._store = new Map(Object.entries(initialConfig));
    }

    get<T>(key: string, defaultValue?: T): T | undefined {
        if (this._store.has(key)) {
            return this._store.get(key) as T;
        }
        return defaultValue;
    }

    set(key: string, value: unknown): void {
        this._store.set(key, value);
    }

    setAll(values: Record<string, unknown>): void {
        for (const [k, v] of Object.entries(values)) {
            this._store.set(k, v);
        }
    }

    clear(): void {
        this._store.clear();
    }

    get provider(): <T>(key: string, defaultValue?: T) => T | undefined {
        return <T>(key: string, defaultValue?: T) => this.get<T>(key, defaultValue);
    }

    toWorkspaceConfiguration() {
        return {
            get: <T>(key: string, defaultValue?: T): T | undefined => this.get<T>(key, defaultValue),
            has: (key: string): boolean => this._store.has(key),
            inspect: <T>(key: string) => ({
                key,
                defaultValue: undefined,
                globalValue: this._store.get(key) as T | undefined,
                workspaceValue: undefined,
            }),
            update: async (key: string, value: unknown): Promise<void> => {
                this._store.set(key, value);
            },
        };
    }
}
