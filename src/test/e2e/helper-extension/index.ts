/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { run } from '../runner';

export function activate(): void {
    run().catch(console.error);
}
