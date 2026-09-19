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

    test('keepStaleOnError retains expired value across failed fetcher calls', async () => {
        const onEvict = vi.fn();
        const cache = new AsyncCache<string, string>({
            ttl: Duration.milliseconds(30),
            keepStaleOnError: true,
            onEvict,
        });

        // 1. Initial successful fetch
        const val1 = await cache.getOrFetch('k1', async () => 'initial');
        expect(val1).toBe('initial');

        // Wait past TTL
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Expired: get() and peek() return undefined, but peekStale() returns 'initial'
        expect(cache.get('k1')).toBeUndefined();
        expect(cache.peek('k1')).toBeUndefined();
        expect(cache.peekStale('k1')).toBe('initial');

        // 2. Fetcher fails
        const failingFetcher = vi.fn().mockRejectedValue(new Error('Network error'));
        await expect(cache.getOrFetch('k1', failingFetcher)).rejects.toThrow('Network error');

        // Still retained!
        expect(cache.peekStale('k1')).toBe('initial');
        expect(onEvict).not.toHaveBeenCalled();

        // 3. Fetcher succeeds later
        const val2 = await cache.getOrFetch('k1', async () => 'recovered');
        expect(val2).toBe('recovered');
        expect(cache.peek('k1')).toBe('recovered');
        expect(cache.peekStale('k1')).toBe('recovered');
        // onEvict was called when replacing the old value
        expect(onEvict).toHaveBeenCalledWith('initial');
    });

    test('keepStaleOnError does not store error state on cold miss', async () => {
        const cache = new AsyncCache<string, string>({
            keepStaleOnError: true,
        });

        await expect(
            cache.getOrFetch('cold', async () => {
                throw new Error('Initial fail');
            }),
        ).rejects.toThrow('Initial fail');

        expect(cache.peekStale('cold')).toBeUndefined();
        expect(cache.size).toBe(0);
    });

    test('peekStale returns undefined after delete() or clear()', async () => {
        const cache = new AsyncCache<string, string>({
            ttl: Duration.milliseconds(30),
            keepStaleOnError: true,
        });

        cache.set('a', 'alpha');
        cache.set('b', 'beta');

        // Wait past TTL
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(cache.peekStale('a')).toBe('alpha');
        expect(cache.peekStale('b')).toBe('beta');

        await cache.delete('a');
        expect(cache.peekStale('a')).toBeUndefined();
        expect(cache.peekStale('b')).toBe('beta');

        await cache.clear();
        expect(cache.peekStale('b')).toBeUndefined();
    });

    test('reports maxEntries from configuration', () => {
        const cache = new AsyncCache<string, string>({ maxEntries: 150 });
        expect(cache.maxEntries).toBe(150);
    });

    test('does not call onEvict twice if entry was already evicted by capacity limits during in-flight fetch', async () => {
        const onEvict = vi.fn();
        const cache = new AsyncCache<string, string>({
            maxEntries: 2,
            ttl: Duration.milliseconds(20),
            keepStaleOnError: true,
            onEvict,
        });

        // Seed cache with 'k1'
        await cache.getOrFetch('k1', async () => 'v1');
        await new Promise((resolve) => setTimeout(resolve, 30)); // Expire 'k1'

        let resolveK1Fetch: (val: string) => void = () => {};
        const k1FetchPromise = cache.getOrFetch(
            'k1',
            () =>
                new Promise<string>((resolve) => {
                    resolveK1Fetch = resolve;
                }),
        );

        // While k1 fetch is in flight, fill cache with k2 and k3 to evict k1
        await cache.getOrFetch('k2', async () => 'v2');
        await cache.getOrFetch('k3', async () => 'v3');

        // At this point, k1 was evicted by LRU capacity
        expect(onEvict).toHaveBeenCalledTimes(1);
        expect(onEvict).toHaveBeenCalledWith('v1');

        // Resolve k1 fetch
        resolveK1Fetch('v1_recovered');
        await k1FetchPromise;

        // onEvict should have been called for v1 (when evicted by k3) and v2 (when evicted by k1_recovered),
        // but crucially NOT twice for 'v1'
        expect(onEvict.mock.calls.filter(([val]) => val === 'v1')).toHaveLength(1);
    });
});
