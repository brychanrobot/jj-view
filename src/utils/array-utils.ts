/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Splits an array into chunks of a specific size.
 *
 * @param array The array to chunk.
 * @param size The maximum size of each chunk.
 * @returns An array of chunks.
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
    if (size <= 0) {
        throw new Error('Chunk size must be greater than 0');
    }
    const result: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}
