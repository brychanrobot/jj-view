/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Immutable duration representation providing type-safe time conversions.
 */
export class Duration {
    private constructor(readonly milliseconds: number) {
        if (Number.isNaN(milliseconds)) {
            throw new RangeError('Duration value cannot be NaN');
        }
    }

    static milliseconds(ms: number): Duration {
        return new Duration(ms);
    }

    static seconds(s: number): Duration {
        return new Duration(s * 1_000);
    }

    static minutes(m: number): Duration {
        return new Duration(m * 60_000);
    }

    static hours(h: number): Duration {
        return new Duration(h * 3_600_000);
    }

    static days(d: number): Duration {
        return new Duration(d * 86_400_000);
    }

    static readonly ZERO = new Duration(0);
    static readonly INFINITY = new Duration(Number.POSITIVE_INFINITY);

    toMilliseconds(): number {
        return this.milliseconds;
    }

    toSeconds(): number {
        return this.milliseconds / 1_000;
    }

    toMinutes(): number {
        return this.milliseconds / 60_000;
    }

    toHours(): number {
        return this.milliseconds / 3_600_000;
    }

    toDays(): number {
        return this.milliseconds / 86_400_000;
    }

    plus(other: Duration): Duration {
        return new Duration(this.milliseconds + other.milliseconds);
    }

    minus(other: Duration): Duration {
        if (this.milliseconds === Number.POSITIVE_INFINITY && other.milliseconds === Number.POSITIVE_INFINITY) {
            return Duration.ZERO;
        }
        return new Duration(this.milliseconds - other.milliseconds);
    }

    equals(other: Duration): boolean {
        return this.milliseconds === other.milliseconds;
    }

    isZero(): boolean {
        return this.milliseconds === 0;
    }

    isPositive(): boolean {
        return this.milliseconds > 0;
    }

    isFinite(): boolean {
        return Number.isFinite(this.milliseconds);
    }

    valueOf(): number {
        return this.milliseconds;
    }
}
