/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AsyncCacheOptions<V> {
    /** Default Time-To-Live in milliseconds for cached entries (default: 5 minutes) */
    ttlMs?: number;
    /** Optional cleanup hook called when an entry is evicted or cleared */
    onEvict?: (value: V) => Promise<void> | void;
    /** Optional clone function applied to returned values to prevent external mutation */
    clone?: (value: V) => V;
}

export class AsyncCache<K = string, V = unknown> {
    private readonly _cache = new Map<K, { value: V; expires: number }>();
    private readonly _promises = new Map<K, Promise<V>>();
    private readonly _defaultTtlMs: number;
    private readonly _onEvict?: (value: V) => Promise<void> | void;
    private readonly _clone?: (value: V) => V;

    constructor(options: AsyncCacheOptions<V> = {}) {
        this._defaultTtlMs = options.ttlMs ?? 5 * 60_000;
        this._onEvict = options.onEvict;
        this._clone = options.clone;
    }

    async getOrFetch(key: K, fetcher: () => Promise<V>, ttlMs?: number): Promise<V> {
        const inProgress = this._promises.get(key);
        if (inProgress) {
            const val = await inProgress;
            return this._clone ? this._clone(val) : val;
        }

        const cached = this._cache.get(key);
        if (cached && Date.now() < cached.expires) {
            return this._clone ? this._clone(cached.value) : cached.value;
        }

        const promise = (async () => {
            if (cached && this._onEvict) {
                this._cache.delete(key);
                await this._onEvict(cached.value);
            }

            const value = await fetcher();
            this._cache.set(key, {
                value,
                expires: Date.now() + (ttlMs ?? this._defaultTtlMs),
            });
            return value;
        })();

        this._promises.set(key, promise);
        try {
            const val = await promise;
            return this._clone ? this._clone(val) : val;
        } finally {
            this._promises.delete(key);
        }
    }

    async clear(): Promise<void> {
        this._promises.clear();
        const entries = Array.from(this._cache.values());
        this._cache.clear();

        if (this._onEvict) {
            const onEvict = this._onEvict;
            await Promise.all(entries.map((e) => onEvict(e.value)));
        }
    }

    async delete(key: K): Promise<boolean> {
        this._promises.delete(key);
        const cached = this._cache.get(key);
        if (cached) {
            this._cache.delete(key);
            if (this._onEvict) {
                await this._onEvict(cached.value);
            }
            return true;
        }
        return false;
    }

    has(key: K): boolean {
        const cached = this._cache.get(key);
        return Boolean(cached && Date.now() < cached.expires);
    }
}
