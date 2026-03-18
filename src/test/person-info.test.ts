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
            const now = Date.now();
            const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
            expect(getRelativeTimeString(oneHourAgo)).toContain('1 hour ago');

            const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
            expect(getRelativeTimeString(twoDaysAgo)).toContain('2 days ago');
        });
    });
});
