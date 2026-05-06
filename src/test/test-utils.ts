/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SinonStub } from 'sinon';
import type { Mock } from 'vitest';

export /**
 * Creates a partial mock of type T.
 * Use this to mock interfaces/classes without implementing every property.
 */
function createMock<T>(partial: Partial<T> = {}): T {
    return partial as unknown as T;
}

export function asMock(fn: unknown): Mock {
    return fn as Mock;
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
