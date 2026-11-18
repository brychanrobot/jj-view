/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { getErrorMessage, isNodeErrorWithCode, toError } from '../../utils/error-utils';

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

    describe('isNodeErrorWithCode', () => {
        it('returns true for Error instances and plain objects with matching string code', () => {
            expect(isNodeErrorWithCode(Object.assign(new Error('missing'), { code: 'ENOENT' }), 'ENOENT')).toBe(true);
            expect(isNodeErrorWithCode({ code: 'EACCES' }, 'EACCES')).toBe(true);
        });

        it('returns false for mismatching codes, non-string codes, and non-objects', () => {
            expect(isNodeErrorWithCode(Object.assign(new Error('denied'), { code: 'EACCES' }), 'ENOENT')).toBe(false);
            expect(isNodeErrorWithCode(new Error('plain'), 'ENOENT')).toBe(false);
            expect(isNodeErrorWithCode({ code: 404 }, '404')).toBe(false);
            expect(isNodeErrorWithCode(null, 'ENOENT')).toBe(false);
            expect(isNodeErrorWithCode(undefined, 'ENOENT')).toBe(false);
            expect(isNodeErrorWithCode('ENOENT', 'ENOENT')).toBe(false);
        });
    });
});
