/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export async function waitUntil(
    condition: () => boolean | Promise<boolean>,
    timeout = 15000,
    interval = 10,
    message?: string,
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await condition()) {
            return;
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(message || `Timeout waiting for condition after ${timeout}ms`);
}
