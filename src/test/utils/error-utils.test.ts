/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { getErrorMessage, toError } from '../../utils/error-utils';

describe('error-utils', () => {
    describe('toError', () => {
        it('returns an Error instance as-is', () => {
            const original = new Error('original error');
            expect(toError(original)).toBe(original);
        });

        it('wraps a string into an Error instance', () => {
            const result = toError('something went wrong');
            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('something went wrong');
        });

        it('wraps numbers, objects, and null/undefined into Error instances', () => {
            expect(toError(404).message).toBe('404');
            expect(toError({ foo: 'bar' }).message).toBe('[object Object]');
            expect(toError(null).message).toBe('null');
            expect(toError(undefined).message).toBe('undefined');
        });
    });

    describe('getErrorMessage', () => {
        it('returns message property from Error instances', () => {
            expect(getErrorMessage(new Error('custom message'))).toBe('custom message');
        });

        it('converts non-Error values to string', () => {
            expect(getErrorMessage('plain string')).toBe('plain string');
            expect(getErrorMessage(1234)).toBe('1234');
            expect(getErrorMessage(null)).toBe('null');
            expect(getErrorMessage(undefined)).toBe('undefined');
        });
    });
});
