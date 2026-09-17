/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface LruCacheOptions<K = string, V = unknown> {
    /** Maximum number of entries to keep in cache before evicting the least recently used entry */
    maxEntries: number;
    /** Optional cleanup hook called when an entry is evicted due to capacity limits */
    onEvict?: (value: V, key: K) => void;
}

/**
 * A fast, Map-based Least-Recently-Used (LRU) cache with bounded capacity.
 */
export class LruCache<K = string, V = unknown> {
    private readonly _cache = new Map<K, V>();
    private readonly _maxEntries: number;
    private readonly _onEvict?: (value: V, key: K) => void;

    constructor(options: LruCacheOptions<K, V>) {
        if (!Number.isFinite(options.maxEntries) || options.maxEntries <= 0) {
            throw new Error(`maxEntries must be greater than 0, received ${options.maxEntries}`);
        }
        this._maxEntries = options.maxEntries;
        this._onEvict = options.onEvict;
    }

    get(key: K): V | undefined {
        if (!this._cache.has(key)) {
            return undefined;
        }
        const val = this._cache.get(key) as V;
        // Refresh access recency: move to the end of insertion order
        this._cache.delete(key);
        this._cache.set(key, val);
        return val;
    }

    peek(key: K): V | undefined {
        return this._cache.get(key);
    }

    set(key: K, value: V): void {
        if (this._cache.has(key)) {
            this._cache.delete(key);
        } else if (this._cache.size >= this._maxEntries) {
            const oldestEntry = this._cache.entries().next().value;
            if (oldestEntry) {
                const [oldestKey, oldestVal] = oldestEntry;
                this._cache.delete(oldestKey);
                if (this._onEvict) {
                    try {
                        this._onEvict(oldestVal, oldestKey);
                    } catch {
                        // Suppress eviction error to avoid corrupting cache set
                    }
                }
            }
        }
        this._cache.set(key, value);
    }

    has(key: K): boolean {
        return this._cache.has(key);
    }

    delete(key: K): boolean {
        return this._cache.delete(key);
    }

    clear(): void {
        this._cache.clear();
    }

    get size(): number {
        return this._cache.size;
    }

    get maxEntries(): number {
        return this._maxEntries;
    }

    keys(): IterableIterator<K> {
        return this._cache.keys();
    }

    values(): IterableIterator<V> {
        return this._cache.values();
    }

    entries(): IterableIterator<[K, V]> {
        return this._cache.entries();
    }
}
