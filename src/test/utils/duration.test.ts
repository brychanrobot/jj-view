/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Duration } from '../../utils/duration';

describe('Duration Unit Tests', () => {
    it('creates duration instances using factory methods', () => {
        expect(Duration.milliseconds(500).toMilliseconds()).toBe(500);
        expect(Duration.seconds(5).toMilliseconds()).toBe(5_000);
        expect(Duration.minutes(10).toMilliseconds()).toBe(600_000);
        expect(Duration.hours(2).toMilliseconds()).toBe(7_200_000);
        expect(Duration.days(1).toMilliseconds()).toBe(86_400_000);
    });

    it('converts to various time units accurately', () => {
        const d = Duration.hours(2.5);
        expect(d.toHours()).toBe(2.5);
        expect(d.toMinutes()).toBe(150);
        expect(d.toSeconds()).toBe(9_000);
        expect(d.toMilliseconds()).toBe(9_000_000);
        expect(d.toDays()).toBeCloseTo(0.104167, 4);
    });

    it('supports arithmetic operations plus and minus', () => {
        const d1 = Duration.minutes(15);
        const d2 = Duration.minutes(45);
        const sum = d1.plus(d2);
        expect(sum.toHours()).toBe(1);

        const diff = d2.minus(d1);
        expect(diff.toMinutes()).toBe(30);
    });

    it('identifies zero, positive, and finite states', () => {
        expect(Duration.ZERO.isZero()).toBe(true);
        expect(Duration.ZERO.isPositive()).toBe(false);
        expect(Duration.ZERO.isFinite()).toBe(true);

        const pos = Duration.seconds(1);
        expect(pos.isZero()).toBe(false);
        expect(pos.isPositive()).toBe(true);
        expect(pos.isFinite()).toBe(true);

        expect(Duration.INFINITY.isFinite()).toBe(false);
        expect(Duration.INFINITY.isPositive()).toBe(true);
    });

    it('returns milliseconds from valueOf for arithmetic expressions', () => {
        const d = Duration.seconds(3);
        expect(Number(d)).toBe(3_000);
        expect(d.valueOf()).toBe(3_000);
    });

    it('throws RangeError when given NaN', () => {
        expect(() => Duration.milliseconds(Number.NaN)).toThrow(RangeError);
        expect(() => Duration.seconds(Number.NaN)).toThrow(RangeError);
    });

    it('safely handles Infinity minus Infinity and checks equality', () => {
        const diff = Duration.INFINITY.minus(Duration.INFINITY);
        expect(diff.isZero()).toBe(true);
        expect(diff.equals(Duration.ZERO)).toBe(true);
        expect(Duration.seconds(60).equals(Duration.minutes(1))).toBe(true);
    });
});
