/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Performs a fetch request that automatically aborts after the given timeout.
 * The AbortController's timeout is always cleared in a finally block, preventing
 * timer leaks when the fetch settles before the timeout fires.
 */
export async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal;
    return await fetch(url, { ...init, signal });
}
