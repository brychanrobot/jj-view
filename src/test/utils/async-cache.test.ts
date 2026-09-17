/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, vi } from 'vitest';
import { AsyncCache } from '../../utils/async-cache';
import { Duration } from '../../utils/duration';

describe('AsyncCache Unit Tests', () => {
    test('fetches and caches results on cache miss', async () => {
        const cache = new AsyncCache<string, number>();
        const fetcher = vi.fn().mockResolvedValue(42);

        const val1 = await cache.getOrFetch('key1', fetcher);
        expect(val1).toBe(42);
        expect(fetcher).toHaveBeenCalledTimes(1);

        const val2 = await cache.getOrFetch('key1', fetcher);
        expect(val2).toBe(42);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('does not expire entries when ttl is not configured (infinite default)', async () => {
        const cache = new AsyncCache<string, string>({ maxEntries: 10 });
        const fetcher = vi.fn().mockResolvedValue('persisted');

        await cache.getOrFetch('k', fetcher);
        expect(cache.has('k')).toBe(true);
        expect(cache.get('k')).toBe('persisted');
    });

    test('expires cached entries after Duration ttl', async () => {
        const cache = new AsyncCache<string, string>({ ttl: Duration.milliseconds(50) });
        let counter = 0;
        const fetcher = vi.fn().mockImplementation(async () => `val_${++counter}`);

        const res1 = await cache.getOrFetch('key1', fetcher);
        expect(res1).toBe('val_1');

        // Wait past TTL
        await new Promise((resolve) => setTimeout(resolve, 60));

        const res2 = await cache.getOrFetch('key1', fetcher);
        expect(res2).toBe('val_2');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('deduplicates concurrent in-flight requests (thundering herd)', async () => {
        const cache = new AsyncCache<string, string>();
        let resolvePromise: (value: string) => void = () => {};
        const fetcher = vi.fn().mockImplementation(
            () =>
                new Promise<string>((resolve) => {
                    resolvePromise = resolve;
                }),
        );

        const promise1 = cache.getOrFetch('key1', fetcher);
        const promise2 = cache.getOrFetch('key1', fetcher);

        expect(fetcher).toHaveBeenCalledTimes(1);

        resolvePromise('data');

        const [res1, res2] = await Promise.all([promise1, promise2]);
        expect(res1).toBe('data');
        expect(res2).toBe('data');
    });

    test('expires cached entries after TTL', async () => {
        const cache = new AsyncCache<string, string>({ ttlMs: 50 });
        let counter = 0;
        const fetcher = vi.fn().mockImplementation(async () => `val_${++counter}`);

        const res1 = await cache.getOrFetch('key1', fetcher);
        expect(res1).toBe('val_1');

        // Wait past TTL
        await new Promise((resolve) => setTimeout(resolve, 60));

        const res2 = await cache.getOrFetch('key1', fetcher);
        expect(res2).toBe('val_2');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('executes onEvict callback on delete and clear', async () => {
        const onEvict = vi.fn();
        const cache = new AsyncCache<string, { id: number }>({ onEvict });

        await cache.getOrFetch('item1', async () => ({ id: 1 }));
        await cache.getOrFetch('item2', async () => ({ id: 2 }));

        expect(cache.has('item1')).toBe(true);

        await cache.delete('item1');
        expect(onEvict).toHaveBeenCalledWith({ id: 1 });
        expect(cache.has('item1')).toBe(false);

        await cache.clear();
        expect(onEvict).toHaveBeenCalledWith({ id: 2 });
    });

    test('applies clone option to returned values', async () => {
        const cache = new AsyncCache<string, { count: number }>({
            clone: (val) => ({ ...val }),
        });

        const initial = await cache.getOrFetch('key', async () => ({ count: 1 }));
        initial.count = 99; // Mutate returned value

        const hit = await cache.getOrFetch('key', async () => ({ count: 1 }));
        expect(hit.count).toBe(1); // Cached value was preserved
    });

    test('evicts and does not cache in-flight fetches if clear is called while fetching', async () => {
        const onEvict = vi.fn();
        const cache = new AsyncCache<string, { id: number }>({ onEvict });

        let resolveFetch: (value: { id: number }) => void = () => {};
        const fetcher = vi.fn().mockImplementation(
            () =>
                new Promise<{ id: number }>((resolve) => {
                    resolveFetch = resolve;
                }),
        );

        const inFlight = cache.getOrFetch('key1', fetcher);
        expect(fetcher).toHaveBeenCalledTimes(1);

        // Clear cache while fetch is in-flight
        await cache.clear();

        // Now resolve the in-flight fetch
        resolveFetch({ id: 42 });
        const res = await inFlight;
        expect(res).toEqual({ id: 42 });

        // onEvict should have been called for the orphaned resolved value
        expect(onEvict).toHaveBeenCalledWith({ id: 42 });

        // Cache must not contain the stale resolved value
        expect(cache.has('key1')).toBe(false);
    });

    test('evicts least recently used items when maxEntries is reached', async () => {
        const onEvict = vi.fn();
        const cache = new AsyncCache<string, string>({ maxEntries: 2, onEvict });

        await cache.getOrFetch('k1', async () => 'v1');
        await cache.getOrFetch('k2', async () => 'v2');
        expect(cache.size).toBe(2);

        // Access k1 to make k2 the least recently used
        await cache.getOrFetch('k1', async () => 'v1');

        // Adding k3 should evict k2
        await cache.getOrFetch('k3', async () => 'v3');
        expect(cache.size).toBe(2);
        expect(cache.has('k1')).toBe(true);
        expect(cache.has('k2')).toBe(false);
        expect(cache.has('k3')).toBe(true);
        expect(onEvict).toHaveBeenCalledWith('v2');
    });

    test('supports synchronous get, peek, and set', () => {
        const cache = new AsyncCache<string, number>({ maxEntries: 2 });
        cache.set('a', 10);
        cache.set('b', 20);

        expect(cache.get('a')).toBe(10);
        expect(cache.peek('b')).toBe(20);
        expect(cache.get('non-existent')).toBeUndefined();
        expect(cache.size).toBe(2);
    });

    test('set() cancels in-flight fetch and prevents it from overwriting explicitly set value', async () => {
        const onEvict = vi.fn();
        const cache = new AsyncCache<string, string>({ onEvict });

        let resolveFetch: (value: string) => void = () => {};
        const fetcher = vi.fn().mockImplementation(
            () =>
                new Promise<string>((resolve) => {
                    resolveFetch = resolve;
                }),
        );

        const inFlight = cache.getOrFetch('k1', fetcher);
        cache.set('k1', 'manual_value');

        resolveFetch('stale_fetched_value');
        await inFlight;

        expect(cache.get('k1')).toBe('manual_value');
        expect(onEvict).toHaveBeenCalledWith('stale_fetched_value');
    });

    test('get() purges expired entries and does not promote them to MRU', async () => {
        const cache = new AsyncCache<string, string>({
            maxEntries: 2,
            ttl: Duration.milliseconds(30),
        });

        cache.set('k1', 'v1');
        cache.set('k2', 'v2', Duration.hours(1));

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(cache.get('k1')).toBeUndefined();
        expect(cache.has('k1')).toBe(false);

        cache.set('k3', 'v3', Duration.hours(1));
        expect(cache.has('k2')).toBe(true);
        expect(cache.has('k3')).toBe(true);
    });
});
