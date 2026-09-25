/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompleteSquashRevisionPayload } from '../../../../src/core/commands/squash-revision';

export function createCompleteSquashRevisionPayload(args: unknown[]): CompleteSquashRevisionPayload {
    if (typeof args[0] === 'string') {
        return { message: args[0] };
    }
    return {};
}
