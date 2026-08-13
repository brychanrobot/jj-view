/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { DiscardChangePayload } from '../../commands/discard-change';
import type { Uri } from '../../uri-utils';

export function createDiscardChangePayload(args: unknown[]): DiscardChangePayload {
    const uri = args[0] as Uri | undefined;
    const changes = args[1];
    const index = args[2] as number | undefined;
    return { uri, changes, index };
}
