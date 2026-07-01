/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';

export class ScopedStub<T extends object, K extends keyof T> implements Disposable {
    private readonly originalValue: T[K];

    constructor(
        private readonly target: T,
        private readonly key: K,
        stubValue: T[K],
    ) {
        this.originalValue = target[key];
        Reflect.set(target, key, stubValue);
    }

    [Symbol.dispose]() {
        Reflect.set(this.target, this.key, this.originalValue);
    }
}

export class ScopedSymlink implements Disposable {
    constructor(
        public readonly linkPath: string,
        target: string,
        type?: fs.symlink.Type,
    ) {
        fs.symlinkSync(target, linkPath, type);
    }

    [Symbol.dispose]() {
        try {
            fs.unlinkSync(this.linkPath);
        } catch {}
    }
}

export class ScopedTempDir implements Disposable {
    public readonly path: string;

    constructor(prefix: string) {
        this.path = fs.realpathSync(fs.mkdtempSync(prefix));
    }

    [Symbol.dispose]() {
        try {
            fs.rmSync(this.path, { recursive: true, force: true });
        } catch {}
    }
}

export { ScopedTestRepo } from './test-repo';

/**
 * An async RAII callback wrapper to execute a deferred cleanup action on scope exit.
 */
export class ScopedAsyncCallback implements AsyncDisposable {
    constructor(private readonly callback: () => Promise<void>) {}

    async [Symbol.asyncDispose]() {
        await this.callback();
    }
}

/**
 * Wraps any object that has a `.dispose()` method in a Proxy implementing the
 * Explicit Resource Management (ERM) protocol (`Disposable` and `AsyncDisposable`).
 *
 * This allows using the resource with native `using` or `await using` declarations
 * for scoped RAII lifecycle management in tests:
 *
 * @example
 * ```ts
 * // Synchronous RAII cleanup
 * using repo = autoCleanup(new TestRepo());
 *
 * // Asynchronous RAII cleanup
 * await using manager = autoCleanup(new JjRepositoryManager(...));
 * ```
 *
 * @param obj The target object containing a `.dispose()` method (sync or async).
 * @returns A Proxy wrapping the target object that intercepts the ERM symbols
 * (`Symbol.dispose` / `Symbol.asyncDispose`) to invoke the target's `.dispose()`,
 * while forwarding all other property accesses and correctly binding methods.
 */
export function autoCleanup<T extends { dispose: () => void | Promise<void> }>(
    obj: T,
): T & AsyncDisposable & Disposable {
    return new Proxy(obj, {
        get(target, prop, receiver) {
            if (prop === Symbol.dispose) {
                return () => {
                    const res = target.dispose();
                    if (res instanceof Promise) {
                        res.catch(() => {});
                    }
                };
            }
            if (prop === Symbol.asyncDispose) {
                return async () => {
                    await target.dispose();
                };
            }
            const value = Reflect.get(target, prop, receiver);
            if (typeof value === 'function') {
                return value.bind(target);
            }
            return value;
        },
        set(target, prop, val, receiver) {
            return Reflect.set(target, prop, val, receiver);
        },
        has(target, prop) {
            return Reflect.has(target, prop);
        },
        ownKeys(target) {
            return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
    }) as T & AsyncDisposable & Disposable;
}
