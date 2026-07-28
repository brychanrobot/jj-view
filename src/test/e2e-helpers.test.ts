/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { escapeXPathString, toPlainSearchString } from './e2e/e2e-helpers';

describe('e2e-helpers XPath & Regex Utilities', () => {
    describe('escapeXPathString', () => {
        it('wraps plain strings in double quotes', () => {
            expect(escapeXPathString('file3.txt')).toBe('"file3.txt"');
            expect(escapeXPathString('Working Copy')).toBe('"Working Copy"');
        });

        it('wraps strings containing double quotes in single quotes', () => {
            expect(escapeXPathString('file "3".txt')).toBe('\'file "3".txt\'');
        });

        it('wraps strings containing single quotes in double quotes', () => {
            expect(escapeXPathString("file's_copy.txt")).toBe('"file\'s_copy.txt"');
        });

        it('uses concat for strings containing both single and double quotes', () => {
            expect(escapeXPathString('file\'s "test".txt')).toBe('concat("file\'s ", \'"\', "test", \'"\', ".txt")');
        });
    });

    describe('toPlainSearchString', () => {
        it('returns plain strings unmodified', () => {
            expect(toPlainSearchString('file.txt')).toBe('file.txt');
        });

        it('extracts plain string from simple RegExp patterns', () => {
            expect(toPlainSearchString(/Working Copy/i)).toBe('Working Copy');
            expect(toPlainSearchString(/file\.txt/)).toBe('file.txt');
        });

        it('extracts longest substring from wildcard or alternation regex patterns', () => {
            expect(toPlainSearchString(/@-1:.*side 1/)).toBe('side 1');
            expect(toPlainSearchString(/\[tag\]/)).toBe('[tag]');
        });
    });
});
