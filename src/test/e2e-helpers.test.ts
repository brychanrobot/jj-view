/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { ensureTextRegex, escapeXPathString, toPlainSearchString } from './e2e/e2e-helpers';

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

    describe('ensureTextRegex', () => {
        it('returns RegExp instances unchanged', () => {
            const regex = /custom-pattern/i;
            expect(ensureTextRegex(regex)).toBe(regex);
        });

        it('converts simple single-word strings into literal matching regexes', () => {
            const regex = ensureTextRegex('hello');
            expect(regex.test('hello')).toBe(true);
            expect(regex.test('say hello world')).toBe(true);
            expect(regex.test('world')).toBe(false);
        });

        it('handles multi-word strings with varied whitespace and permits arbitrary text between words', () => {
            const regex = ensureTextRegex('  first   second \t third  ');
            expect(regex.test('first second third')).toBe(true);
            expect(regex.test('first\nsecond\nthird')).toBe(true);
            expect(regex.test('first word second test third')).toBe(true);
            expect(regex.test('first third')).toBe(false);
        });

        it('fully escapes regex special characters and preserves literal semantics', () => {
            const specialString = 'a+b*c? (test) [bar] ^start $end';
            const regex = ensureTextRegex(specialString);
            expect(regex.test('a+b*c? (test) [bar] ^start $end')).toBe(true);
            expect(regex.test('abc (test) [bar] ^start $end')).toBe(false);
            expect(regex.test('a+b*c? test bar start end')).toBe(false);
        });

        it('defines explicit behavior for empty or whitespace-only strings', () => {
            const emptyRegex = ensureTextRegex('');
            expect(emptyRegex.source).toBe('(?:)');
            expect(emptyRegex.test('')).toBe(true);
            expect(emptyRegex.test('any content')).toBe(true);

            const whitespaceRegex = ensureTextRegex('   \t \n  ');
            expect(whitespaceRegex.source).toBe('(?:)');
            expect(whitespaceRegex.test('')).toBe(true);
            expect(whitespaceRegex.test('any content')).toBe(true);
        });
    });
});
