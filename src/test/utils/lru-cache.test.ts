/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { LruCache } from '../../utils/lru-cache';

describe('LruCache Unit Tests', () => {
    it('throws when maxEntries is zero, negative, or NaN', () => {
        expect(() => new LruCache({ maxEntries: 0 })).toThrow('maxEntries must be greater than 0');
        expect(() => new LruCache({ maxEntries: -5 })).toThrow('maxEntries must be greater than 0');
        expect(() => new LruCache({ maxEntries: Number.NaN })).toThrow('maxEntries must be greater than 0');
    });

    it('refreshes recency when cached value is undefined', () => {
        const cache = new LruCache<string, unknown>({ maxEntries: 2 });
        cache.set('a', undefined);
        cache.set('b', 'valueB');

        // Access 'a' which has undefined value
        expect(cache.get('a')).toBeUndefined();
        expect(cache.has('a')).toBe(true);

        // Insert 'c', which should evict 'b' (since 'a' recency was refreshed)
        cache.set('c', 'valueC');
        expect(cache.has('a')).toBe(true);
        expect(cache.has('b')).toBe(false);
        expect(cache.has('c')).toBe(true);
    });

    it('stores and retrieves values correctly', () => {
        const cache = new LruCache<string, number>({ maxEntries: 3 });
        cache.set('a', 1);
        cache.set('b', 2);

        expect(cache.get('a')).toBe(1);
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBeUndefined();
        expect(cache.has('a')).toBe(true);
        expect(cache.has('c')).toBe(false);
        expect(cache.size).toBe(2);
    });

    it('evicts least recently used items when capacity is exceeded', () => {
        const onEvict = vi.fn();
        const cache = new LruCache<string, string>({ maxEntries: 2, onEvict });

        cache.set('k1', 'v1');
        cache.set('k2', 'v2');
        expect(cache.size).toBe(2);

        // Setting a 3rd key should evict 'k1'
        cache.set('k3', 'v3');
        expect(cache.size).toBe(2);
        expect(cache.has('k1')).toBe(false);
        expect(cache.get('k1')).toBeUndefined();
        expect(cache.get('k2')).toBe('v2');
        expect(cache.get('k3')).toBe('v3');
        expect(onEvict).toHaveBeenCalledWith('v1', 'k1');
        expect(onEvict).toHaveBeenCalledTimes(1);
    });

    it('refreshes recency on get so accessed items are not evicted', () => {
        const onEvict = vi.fn();
        const cache = new LruCache<string, string>({ maxEntries: 2, onEvict });

        cache.set('k1', 'v1');
        cache.set('k2', 'v2');

        // Access k1, making k2 the least recently used
        expect(cache.get('k1')).toBe('v1');

        // Setting k3 should now evict k2 instead of k1
        cache.set('k3', 'v3');
        expect(cache.has('k1')).toBe(true);
        expect(cache.has('k2')).toBe(false);
        expect(cache.has('k3')).toBe(true);
        expect(onEvict).toHaveBeenCalledWith('v2', 'k2');
    });

    it('peek reads value without refreshing access recency', () => {
        const cache = new LruCache<string, string>({ maxEntries: 2 });
        cache.set('k1', 'v1');
        cache.set('k2', 'v2');

        // Peek k1 without touching LRU order
        expect(cache.peek('k1')).toBe('v1');

        // Adding k3 should still evict k1
        cache.set('k3', 'v3');
        expect(cache.has('k1')).toBe(false);
        expect(cache.has('k2')).toBe(true);
        expect(cache.has('k3')).toBe(true);
    });

    it('overwriting an existing key updates value and recency without triggering onEvict', () => {
        const onEvict = vi.fn();
        const cache = new LruCache<string, string>({ maxEntries: 2, onEvict });

        cache.set('k1', 'v1');
        cache.set('k2', 'v2');

        // Update k1
        cache.set('k1', 'v1-updated');
        expect(onEvict).not.toHaveBeenCalled();

        // Adding k3 should evict k2 (since k1 was updated and is more recent)
        cache.set('k3', 'v3');
        expect(cache.has('k1')).toBe(true);
        expect(cache.get('k1')).toBe('v1-updated');
        expect(cache.has('k2')).toBe(false);
        expect(onEvict).toHaveBeenCalledWith('v2', 'k2');
    });

    it('deletes entries and clears correctly', () => {
        const cache = new LruCache<string, number>({ maxEntries: 3 });
        cache.set('a', 1);
        cache.set('b', 2);

        expect(cache.delete('a')).toBe(true);
        expect(cache.delete('non-existent')).toBe(false);
        expect(cache.size).toBe(1);

        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.get('b')).toBeUndefined();
    });
});
