/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, vi } from 'vitest';
import { AsyncCache } from '../../utils/async-cache';

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
});
