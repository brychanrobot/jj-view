/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function getRelativeTimeString(timestamp: string | number, now: number | null = null): string {
    const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    if (Number.isNaN(time)) {
        return String(timestamp);
    }

    // If we assume a year is 365.25 days:
    const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
    const SECONDS_PER_MONTH = SECONDS_PER_YEAR / 12;

    const diffMs = (now ?? Date.now()) - time;
    // This function only works for timestamps in the past.
    if (diffMs > -5000 && diffMs < 0) {
        return 'just now';
    }
    if (diffMs <= -5000) {
        return typeof timestamp === 'number' ? new Date(timestamp).toLocaleString() : timestamp;
    }

    // Display a single unit of time from seconds to years.
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(seconds / SECONDS_PER_MONTH);
    const years = Math.floor(seconds / SECONDS_PER_YEAR);
    for (const [x, unit] of [
        [years, 'year'],
        [months, 'month'],
        [weeks, 'week'],
        [days, 'day'],
        [hours, 'hour'],
        [minutes, 'minute'],
        [seconds, 'second'],
    ] satisfies Array<[number, string]>) {
        if (x > 0) {
            return `${x} ${unit}${x > 1 ? 's' : ''} ago`;
        }
    }
    return 'just now';
}
