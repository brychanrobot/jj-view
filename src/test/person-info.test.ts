/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { getPersonDisplayStrings, getRelativeTimeString } from '../webview/components/PersonInfo';

describe('PersonInfo Logic', () => {
    describe('getPersonDisplayStrings', () => {
        const dummyTime = new Date().toISOString();
        it('uses name when both name and email are present', () => {
            const result = getPersonDisplayStrings({ name: 'Alice', email: 'alice@example.com', timestamp: dummyTime });
            expect(result.nameToDisplay).toBe('Alice');
            expect(result.emailToDisplay).toBe('alice@example.com');
            expect(result.hasEmail).toBe(true);
        });

        it('falls back to email for name if name is missing', () => {
            const result = getPersonDisplayStrings({ name: '', email: 'bob@example.com', timestamp: dummyTime });
            expect(result.nameToDisplay).toBe('bob@example.com');
            expect(result.emailToDisplay).toBe('bob@example.com');
            expect(result.hasEmail).toBe(true);
        });

        it('falls back to email for name if name is •', () => {
            const result = getPersonDisplayStrings({ name: '•', email: 'carol@example.com', timestamp: dummyTime });
            expect(result.nameToDisplay).toBe('carol@example.com');
            expect(result.emailToDisplay).toBe('carol@example.com');
            expect(result.hasEmail).toBe(true);
        });

        it('shows (no name set) and (no email set) if both missing', () => {
            const result = getPersonDisplayStrings({ name: '', email: '', timestamp: dummyTime });
            expect(result.nameToDisplay).toBe('(no name set)');
            expect(result.emailToDisplay).toBe('(no email set)');
            expect(result.hasEmail).toBe(false);
        });

        it('shows (no email set) if email is missing but name is present', () => {
            const result = getPersonDisplayStrings({ name: 'Dave', email: '', timestamp: dummyTime });
            expect(result.nameToDisplay).toBe('Dave');
            expect(result.emailToDisplay).toBe('(no email set)');
            expect(result.hasEmail).toBe(false);
        });
    });

    describe('getRelativeTimeString', () => {
        it('calculates relative time correctly', () => {
            // Set "now" to be February 10 at 12:34:56 so that we have some wiggle room for testing values in the past.
            const now = new Date('2026-02-10T12:34:56.000Z').getTime();

            // Timestamp in the future.
            expect(getRelativeTimeString('2026-03-01', now)).toEqual('2026-03-01');

            // Same timestamp.
            expect(getRelativeTimeString(new Date(now).toISOString(), now)).toEqual('just now');
            // Difference is less than 1 second.
            expect(getRelativeTimeString('2026-02-10T12:34:55.001Z', now)).toEqual('just now');

            // Difference is less than 1 minute.
            expect(getRelativeTimeString('2026-02-10T12:34:55.000Z', now)).toEqual('1 second ago');
            expect(getRelativeTimeString('2026-02-10T12:34:30.000Z', now)).toEqual('26 seconds ago');
            expect(getRelativeTimeString('2026-02-10T12:34:00.000Z', now)).toEqual('56 seconds ago');
            expect(getRelativeTimeString('2026-02-10T12:33:56.001Z', now)).toEqual('59 seconds ago');

            // Difference is less than 1 hour.
            expect(getRelativeTimeString('2026-02-10T12:33:56.000Z', now)).toEqual('1 minute ago');
            expect(getRelativeTimeString('2026-02-10T12:30:00.000Z', now)).toEqual('4 minutes ago');
            expect(getRelativeTimeString('2026-02-10T12:00:00.000Z', now)).toEqual('34 minutes ago');
            expect(getRelativeTimeString('2026-02-10T11:34:56.001Z', now)).toEqual('59 minutes ago');

            // Difference is less than 1 day.
            expect(getRelativeTimeString('2026-02-10T11:34:56.000Z', now)).toEqual('1 hour ago');
            expect(getRelativeTimeString('2026-02-10T10:34:56.001Z', now)).toEqual('1 hour ago');
            expect(getRelativeTimeString('2026-02-10T10:34:56.000Z', now)).toEqual('2 hours ago');
            expect(getRelativeTimeString('2026-02-10T00:00:00.000Z', now)).toEqual('12 hours ago');
            expect(getRelativeTimeString('2026-02-09T12:34:56.001Z', now)).toEqual('23 hours ago');

            // Difference is less than 1 week.
            expect(getRelativeTimeString('2026-02-09T12:34:56.000Z', now)).toEqual('1 day ago');
            expect(getRelativeTimeString('2026-02-09T00:00:00.000Z', now)).toEqual('1 day ago');
            expect(getRelativeTimeString('2026-02-05T00:00:00.000Z', now)).toEqual('5 days ago');
            expect(getRelativeTimeString('2026-02-03T12:34:56.001Z', now)).toEqual('6 days ago');

            // Difference is less than 1 month, which is 30.4375 days.
            expect(getRelativeTimeString('2026-02-03T12:34:56.000Z', now)).toEqual('1 week ago');
            expect(getRelativeTimeString('2026-01-28T00:00:00.000Z', now)).toEqual('1 week ago');
            expect(getRelativeTimeString('2026-01-21T00:00:00.000Z', now)).toEqual('2 weeks ago');
            expect(getRelativeTimeString('2026-01-14T00:00:00.000Z', now)).toEqual('3 weeks ago');
            expect(getRelativeTimeString('2026-01-11T02:04:56.001Z', now)).toEqual('4 weeks ago');

            // Difference is less than 1 year, which is 365.25 days.
            expect(getRelativeTimeString('2026-01-11T02:04:56.000Z', now)).toEqual('1 month ago');
            expect(getRelativeTimeString('2026-01-11T00:00:00.000Z', now)).toEqual('1 month ago');
            expect(getRelativeTimeString('2025-12-01T00:00:00.000Z', now)).toEqual('2 months ago');
            expect(getRelativeTimeString('2025-07-01T00:00:00.000Z', now)).toEqual('7 months ago');
            expect(getRelativeTimeString('2025-02-10T13:00:00.000Z', now)).toEqual('11 months ago');
            expect(getRelativeTimeString('2025-02-10T06:34:56.001Z', now)).toEqual('11 months ago');

            // Difference is at least 1 year.
            expect(getRelativeTimeString('2025-02-10T06:34:56.000Z', now)).toEqual('1 year ago');
            expect(getRelativeTimeString('2020-01-01T00:00:00.000Z', now)).toEqual('6 years ago');
        });
    });
});
