/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getRelativeTimeString } from '../../webview/common/utils/time-utils';

describe('time-utils tests', () => {
    describe('getRelativeTimeString', () => {
        const now = new Date('2026-02-10T12:34:56.000Z').getTime();

        it('handles numeric epoch millisecond timestamps', () => {
            const tenSecondsAgo = now - 10_000;
            expect(getRelativeTimeString(tenSecondsAgo, now)).toBe('10 seconds ago');

            const fiveMinutesAgo = now - 5 * 60 * 1000;
            expect(getRelativeTimeString(fiveMinutesAgo, now)).toBe('5 minutes ago');

            const threeHoursAgo = now - 3 * 60 * 60 * 1000;
            expect(getRelativeTimeString(threeHoursAgo, now)).toBe('3 hours ago');
        });

        it('handles string ISO timestamps', () => {
            expect(getRelativeTimeString('2026-02-10T12:34:50.000Z', now)).toBe('6 seconds ago');
            expect(getRelativeTimeString('2026-02-10T12:33:56.000Z', now)).toBe('1 minute ago');
            expect(getRelativeTimeString('2026-02-10T10:34:56.000Z', now)).toBe('2 hours ago');
            expect(getRelativeTimeString('2026-02-09T12:34:56.000Z', now)).toBe('1 day ago');
        });

        it('returns "just now" for zero diff or sub-second diff', () => {
            expect(getRelativeTimeString(now, now)).toBe('just now');
            expect(getRelativeTimeString(now - 500, now)).toBe('just now');
        });

        it('returns string representation for future timestamps or invalid strings', () => {
            const futureTime = now + 10_000;
            expect(getRelativeTimeString(futureTime, now)).toBe(new Date(futureTime).toLocaleString());
            expect(getRelativeTimeString('invalid-date', now)).toBe('invalid-date');
        });
    });
});
