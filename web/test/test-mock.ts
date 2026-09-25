/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function createMock<T extends object>(overrides: Partial<T> = {}): T {
    return new Proxy(overrides, {
        get(target, prop, receiver) {
            if (prop in target) {
                return Reflect.get(target, prop, receiver);
            }
            return undefined;
        },
    }) as T;
}
