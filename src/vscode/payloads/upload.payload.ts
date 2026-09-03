/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../core/commands/command-utils';
import type { UploadPayload } from '../../core/commands/upload';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createUploadPayload(args: unknown[]): UploadPayload {
    const revision = extractRevision(args);
    const firstArg = args[0];
    let mode: 'auto' | 'single' | 'stack' = 'single';

    if (isRecord(firstArg)) {
        if (firstArg.mode === 'auto' || firstArg.mode === 'single' || firstArg.mode === 'stack') {
            mode = firstArg.mode;
        }
    }

    return { revision, mode };
}

export function createUploadStackPayload(args: unknown[]): UploadPayload {
    const revision = extractRevision(args);
    return { revision, mode: 'stack' };
}
