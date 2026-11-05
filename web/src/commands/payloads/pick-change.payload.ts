/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type PickChangePayload, parsePickChangePayload } from '../../../../src/core/commands/pick-change';

/** Reads `revset` from the args object of a `${input:...}` variable of type `command`. */
export function createPickChangePayload(args: unknown[]): PickChangePayload {
    return parsePickChangePayload(args);
}
