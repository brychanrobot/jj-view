/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalizes an unknown caught error into a standard Error instance.
 * If the value is already an Error, it is returned as-is.
 * Otherwise, a new Error instance is created with String(error) as the message.
 */
export function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    return new Error(String(error));
}

/**
 * Extracts a human-readable error message from an unknown error value.
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
