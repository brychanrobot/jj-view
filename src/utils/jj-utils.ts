/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a JJ Change-Id (reverse hex, k-z) to standard Hex (0-f).
 * JJ uses 'z' for 0, 'y' for 1, ..., 'k' for 15.
 */
export function convertJjChangeIdToHex(jjChangeId: string): string {
    let result = '';
    for (let i = 0; i < jjChangeId.length; i++) {
        const charCode = jjChangeId.charCodeAt(i);
        // Ensure char is within range k-z (107-122)
        if (charCode >= 107 && charCode <= 122) {
            const val = 122 - charCode;
            result += val.toString(16);
        } else {
            throw new Error(`Invalid character '${jjChangeId[i]}' in JJ Change-Id: ${jjChangeId}`);
        }
    }
    return result;
}

/**
 * Shortens a change ID to at least minLen characters.
 * If changeId is shorter than minLen, it returns the full ID.
 */
export function shortenChangeId(changeId: string, minLen: number): string {
    if (!changeId) {
        return '';
    }
    return changeId.substring(0, Math.max(minLen, 0));
}

/**
 * Calculates the total length of the change ID to display,
 * respecting the unique prefix and the configured minimum length.
 */
export function getChangeIdDisplayLength(shortestId: string | undefined, minLen: number): number {
    return Math.max(minLen, shortestId?.length || 0);
}

/**
 * Formats a change ID for display using the unique prefix if available and the configured minimum length.
 */
export function formatDisplayChangeId(
    changeId: string,
    shortestId: string | undefined,
    minLen: number,
): string {
    const displayLen = getChangeIdDisplayLength(shortestId, minLen);
    return shortenChangeId(changeId, displayLen);
}
