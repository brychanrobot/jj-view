/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { calculateNextSelection, hasImmutableSelection } from '../webview/utils/selection-utils';

describe('selection-utils', () => {
    describe('calculateNextSelection', () => {
        it('selects single item when multiSelect is false', () => {
            const current = new Set(['a', 'b']);
            const result = calculateNextSelection(current, 'c', false);
            expect(result.size).toBe(1);
            expect(result.has('c')).toBe(true);
        });

        it('toggles item off when multiSelect is true and item is already selected', () => {
            const current = new Set(['a', 'b']);
            const result = calculateNextSelection(current, 'a', true);
            expect(result.size).toBe(1);
            expect(result.has('b')).toBe(true);
        });

        it('adds item when multiSelect is true and item is not selected', () => {
            const current = new Set(['a']);
            const result = calculateNextSelection(current, 'b', true);
            expect(result.size).toBe(2);
            expect(result.has('a')).toBe(true);
            expect(result.has('b')).toBe(true);
        });

        it('deselects item if it is the only one selected and multiSelect is true (toggle off)', () => {
            const current = new Set(['a']);
            const result = calculateNextSelection(current, 'a', true);
            expect(result.size).toBe(0);
        });

        it('if multiSelect is false and clicking already selected item, deselects it (toggle off)', () => {
            const current = new Set(['a']);
            const result = calculateNextSelection(current, 'a', false);
            expect(result.size).toBe(0);
        });

        it('if multiSelect is false and clicking one of many selected, selects ONLY that one', () => {
            const current = new Set(['a', 'b']);
            const result = calculateNextSelection(current, 'b', false);
            expect(result.size).toBe(1);
            expect(result.has('b')).toBe(true);
        });
    });

    describe('hasImmutableSelection', () => {
        it('returns false for empty selection', () => {
            expect(hasImmutableSelection(new Set(), [])).toBe(false);
        });

        it('returns false if all selected are mutable', () => {
            const commits = [
                { change_id: 'a', is_immutable: false },
                { change_id: 'b', is_immutable: false },
            ];
            expect(hasImmutableSelection(new Set(['a', 'b']), commits)).toBe(false);
        });

        it('returns true if any selected is immutable', () => {
            const commits = [
                { change_id: 'a', is_immutable: false },
                { change_id: 'b', is_immutable: true },
            ];
            expect(hasImmutableSelection(new Set(['a', 'b']), commits)).toBe(true);
        });

        it('returns true if all selected are immutable', () => {
            const commits = [
                { change_id: 'a', is_immutable: true },
                { change_id: 'b', is_immutable: true },
            ];
            expect(hasImmutableSelection(new Set(['a', 'b']), commits)).toBe(true);
        });
    });
});
