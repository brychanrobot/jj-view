/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare global {
    function logPerf(message: string, startTime?: number, prefix?: string, suffix?: string): void;
    function waitUntil(
        condition: () => boolean | Promise<boolean>,
        timeout?: number,
        interval?: number,
        message?: string,
    ): Promise<void>;
}

export {};
