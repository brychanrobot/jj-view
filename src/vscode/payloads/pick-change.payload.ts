/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PickChangePayload } from '../../core/commands/pick-change';

/** Reads `revset` from the args object of a `${input:...}` variable of type `command`. */
export function createPickChangePayload(args: unknown[]): PickChangePayload {
    const arg = args[0];
    if (typeof arg === 'object' && arg !== null && 'revset' in arg && typeof arg.revset === 'string') {
        return { revset: arg.revset };
    }
    return {};
}
