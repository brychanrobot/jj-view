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

// biome-ignore lint/suspicious/noExplicitAny: accessPrivate is a test utility intended to bypass type safety for testing private members.
export function accessPrivate(obj: any, key: string): any {
    return obj[key];
}
