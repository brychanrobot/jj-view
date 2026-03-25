/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
    convertJjChangeIdToHex,
    shortenChangeId,
    getChangeIdDisplayLength,
    formatDisplayChangeId,
    formatCommitTitle,
} from '../utils/jj-utils';

describe('JJ Utils', () => {
    describe('convertJjChangeIdToHex', () => {
        it('should convert jj change ids to hex', () => {
            expect(convertJjChangeIdToHex('zzzz')).toBe('0000');
            expect(convertJjChangeIdToHex('yyyy')).toBe('1111');
            expect(convertJjChangeIdToHex('kkkk')).toBe('ffff');
            expect(convertJjChangeIdToHex('zyxw')).toBe('0123');
        });

        it('should throw on invalid characters', () => {
            expect(() => convertJjChangeIdToHex('abc')).toThrow();
        });
    });

    describe('shortenChangeId', () => {
        it('should return empty string for empty input', () => {
            expect(shortenChangeId('', 8)).toBe('');
        });

        it('should shorten longer IDs', () => {
            expect(shortenChangeId('abcdefghij', 4)).toBe('abcd');
            expect(shortenChangeId('abcdefghij', 8)).toBe('abcdefgh');
        });

        it('should return full ID if it is shorter than minLen', () => {
            expect(shortenChangeId('abc', 8)).toBe('abc');
        });

        it('should handle minLen 0', () => {
            expect(shortenChangeId('abc', 0)).toBe('');
        });
    });

    describe('getChangeIdDisplayLength', () => {
        it('should return minLen if shortestId is missing', () => {
            expect(getChangeIdDisplayLength(undefined, 8)).toBe(8);
            expect(getChangeIdDisplayLength(undefined, 1)).toBe(1);
        });

        it('should return minLen if shortestId is shorter than minLen', () => {
            expect(getChangeIdDisplayLength('abc', 8)).toBe(8);
        });

        it('should return shortestId length if it is longer than minLen', () => {
            expect(getChangeIdDisplayLength('abcdefghij', 4)).toBe(10);
        });
    });

    describe('formatDisplayChangeId', () => {
        const fullId = 'abcdefghijklmnopqrstuvwxyz';

        it('should use minLen if shortestId is missing', () => {
            expect(formatDisplayChangeId(fullId, undefined, 8)).toBe('abcdefgh');
        });

        it('should use minLen if shortestId is shorter than minLen', () => {
            expect(formatDisplayChangeId(fullId, 'abc', 8)).toBe('abcdefgh');
        });

        it('should use shortestId length if it is longer than minLen', () => {
            expect(formatDisplayChangeId(fullId, 'abcdefghij', 4)).toBe('abcdefghij');
        });

        it('should handle short full ID', () => {
            expect(formatDisplayChangeId('abc', 'abc', 8)).toBe('abc');
        });
    });

    describe('formatCommitTitle', () => {
        const fullId = 'abcdefghijklmnopqrstuvwxyz';

        it('should use minLen if shortestId is missing', () => {
            const commit = { change_id: fullId };
            expect(formatCommitTitle(commit, 8)).toBe('Commit: abcdefgh');
        });

        it('should use shortestId length if it is longer than minLen', () => {
            const commit = { change_id: fullId, change_id_shortest: 'abcd' };
            expect(formatCommitTitle(commit, 1)).toBe('Commit: abcd');
        });

        it('should append offset for divergent commits', () => {
            const commit = {
                change_id: 'abc/1',
                is_divergent: true,
                change_id_offset: 1,
            };
            // Note: substring(0, 1) on "abc/1" is "a"
            expect(formatCommitTitle(commit, 1)).toBe('Commit: a⧸1');
        });

        it('should truncate offset from base change_id even without splitting', () => {
            const commit = {
                change_id: 'vykwzknv/1',
                is_divergent: true,
                change_id_offset: 1,
                change_id_shortest: 'vykw',
            };
            // displayLen = 4. "vykwzknv/1".substring(0, 4) = "vykw"
            expect(formatCommitTitle(commit, 1)).toBe('Commit: vykw⧸1');
        });

        it('should handle regular commits with no offset', () => {
            const commit = {
                change_id: 'abcdef',
                is_divergent: false,
            };
            expect(formatCommitTitle(commit, 8)).toBe('Commit: abcdef');
        });
    });
});
