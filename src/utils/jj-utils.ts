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
