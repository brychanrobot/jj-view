/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Mock } from 'vitest';
import { SinonStub } from 'sinon';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function accessPrivate(obj: any, key: string): any {
    return obj[key];
}
