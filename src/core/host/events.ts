/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Disposable {
    dispose(): void;
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export type AsyncEvent<T> = (
    listener: (e: T) => Promise<void> | void,
    thisArgs?: unknown,
    disposables?: Disposable[],
) => Disposable;

interface ListenerEntry<T> {
    fn: (e: T) => unknown;
    isDisposed: boolean;
}

interface AsyncListenerEntry<T> {
    fn: (e: T) => Promise<void> | void;
    isDisposed: boolean;
}

export class EventEmitter<T> implements Disposable {
    private _listeners: ListenerEntry<T>[] | undefined;
    private _disposed = false;

    public readonly event: Event<T> = (
        listener: (e: T) => unknown,
        thisArgs?: unknown,
        disposables?: Disposable[],
    ): Disposable => {
        const boundListener = thisArgs ? listener.bind(thisArgs) : listener;
        const entry: ListenerEntry<T> = { fn: boundListener, isDisposed: false };

        const result: Disposable = {
            dispose: () => {
                if (entry.isDisposed || !this._listeners) {
                    entry.isDisposed = true;
                    return;
                }
                entry.isDisposed = true;
                const idx = this._listeners.indexOf(entry);
                if (idx !== -1) {
                    this._listeners.splice(idx, 1);
                }
            },
        };

        if (disposables) {
            disposables.push(result);
        }

        if (this._disposed) {
            entry.isDisposed = true;
            return result;
        }

        if (!this._listeners) {
            this._listeners = [];
        }
        this._listeners.push(entry);

        return result;
    };

    public fire(data: T): void {
        if (this._disposed || !this._listeners || this._listeners.length === 0) {
            return;
        }
        const entries = [...this._listeners];
        for (const entry of entries) {
            if (this._disposed) {
                break;
            }
            if (entry.isDisposed) {
                continue;
            }
            try {
                entry.fn(data);
            } catch (err) {
                console.error('Error in EventEmitter listener:', err);
            }
        }
    }

    public dispose(): void {
        this._disposed = true;
        if (this._listeners) {
            for (const entry of this._listeners) {
                entry.isDisposed = true;
            }
        }
        this._listeners = undefined;
    }
}

export class AsyncEventEmitter<T> implements Disposable {
    private _listeners: AsyncListenerEntry<T>[] | undefined;
    private _disposed = false;

    public readonly event: AsyncEvent<T> = (
        listener: (event: T) => Promise<void> | void,
        thisArgs?: unknown,
        disposables?: Disposable[],
    ): Disposable => {
        const boundListener = thisArgs ? listener.bind(thisArgs) : listener;
        const entry: AsyncListenerEntry<T> = { fn: boundListener, isDisposed: false };

        const result: Disposable = {
            dispose: () => {
                if (entry.isDisposed || !this._listeners) {
                    entry.isDisposed = true;
                    return;
                }
                entry.isDisposed = true;
                const index = this._listeners.indexOf(entry);
                if (index !== -1) {
                    this._listeners.splice(index, 1);
                }
            },
        };

        if (disposables) {
            disposables.push(result);
        }

        if (this._disposed) {
            entry.isDisposed = true;
            return result;
        }

        if (!this._listeners) {
            this._listeners = [];
        }
        this._listeners.push(entry);

        return result;
    };

    public async fire(event: T): Promise<void> {
        if (this._disposed || !this._listeners || this._listeners.length === 0) {
            return;
        }
        const entries = [...this._listeners];
        const promises = entries.map(async (entry) => {
            if (this._disposed || entry.isDisposed) {
                return;
            }
            try {
                await entry.fn(event);
            } catch (err) {
                console.error('Error in AsyncEventEmitter listener:', err);
            }
        });
        await Promise.all(promises);
    }

    public dispose(): void {
        this._disposed = true;
        if (this._listeners) {
            for (const entry of this._listeners) {
                entry.isDisposed = true;
            }
        }
        this._listeners = undefined;
    }
}

export function disposeSafely(disposable: Disposable | undefined, onError?: (err: unknown) => void): void {
    if (!disposable || typeof disposable.dispose !== 'function') {
        return;
    }
    try {
        disposable.dispose();
    } catch (err) {
        onError?.(err);
    }
}
