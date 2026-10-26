/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Duration } from './duration';
import { LruCache } from './lru-cache';

export interface AsyncCacheOptions<V> {
    /** Default Time-To-Live as a Duration for cached entries */
    ttl?: Duration;
    /** Default Time-To-Live in milliseconds for cached entries (alternative to ttl) */
    ttlMs?: number;
    /** Maximum number of entries to keep in cache before evicting the least recently used entry */
    maxEntries?: number;
    /** Optional cleanup hook called when an entry is evicted or cleared */
    onEvict?: (value: V) => Promise<void> | void;
    /** Optional clone function applied to returned values to prevent external mutation */
    clone?: (value: V) => V;
    /** Retain expired/stale entry in cache if fetcher throws an error */
    keepStaleOnError?: boolean;
}

/**
 * Result of a single fetch attempt. `stored` is false when the entry was
 * invalidated (clear/delete/set) while the fetch was in flight; in that case
 * the value has already been passed to `onEvict` and must not be handed out.
 */
interface FetchOutcome<V> {
    value: V;
    stored: boolean;
}

export class AsyncCache<K = string, V = unknown> {
    /**
     * Upper bound on consecutive mid-flight invalidations tolerated before a
     * fetched value is stored regardless. Prevents livelock under a constantly
     * clearing cache while still guaranteeing callers never receive an evicted value.
     */
    private static readonly MAX_INVALIDATION_RETRIES = 3;

    private readonly _cache: LruCache<K, { value: V; expires: number }>;
    private readonly _promises = new Map<K, Promise<FetchOutcome<V>>>();
    private readonly _defaultTtl: Duration;
    private readonly _onEvict?: (value: V) => Promise<void> | void;
    private readonly _clone?: (value: V) => V;
    private readonly _keepStaleOnError: boolean;

    private _epoch = 0;

    constructor(options: AsyncCacheOptions<V> = {}) {
        this._defaultTtl =
            options.ttl ?? (options.ttlMs !== undefined ? Duration.milliseconds(options.ttlMs) : Duration.INFINITY);
        this._onEvict = options.onEvict;
        this._clone = options.clone;
        this._keepStaleOnError = options.keepStaleOnError ?? false;

        this._cache = new LruCache<K, { value: V; expires: number }>({
            maxEntries: options.maxEntries ?? Number.MAX_SAFE_INTEGER,
            onEvict: (entry) => {
                if (this._onEvict) {
                    void Promise.resolve(this._onEvict(entry.value)).catch(() => {});
                }
            },
        });
    }

    get defaultTtl(): Duration {
        return this._defaultTtl;
    }

    get maxEntries(): number {
        return this._cache.maxEntries;
    }

    /**
     * Returns the cached value for `key`, fetching it if missing or expired.
     *
     * Values whose fetch is invalidated mid-flight (by `clear()`, `delete()` or
     * `set()`) are evicted and never returned; the lookup is re-evaluated instead,
     * coalescing with any newer in-flight fetch or explicitly set value.
     */
    async getOrFetch(key: K, fetcher: () => Promise<V>, ttl?: Duration): Promise<V> {
        for (let attempt = 0; ; attempt++) {
            const inProgress = this._promises.get(key);
            if (inProgress) {
                const outcome = await inProgress;
                if (outcome.stored) {
                    return this._clone ? this._clone(outcome.value) : outcome.value;
                }
                continue;
            }

            const cached = this._cache.peek(key);
            if (cached && Date.now() < cached.expires) {
                const entry = this._cache.get(key);
                if (entry) {
                    return this._clone ? this._clone(entry.value) : entry.value;
                }
            }

            const forceStore = attempt >= AsyncCache.MAX_INVALIDATION_RETRIES;
            const outcome = await this._fetchAndStore(key, fetcher, ttl, cached, forceStore);
            if (outcome.stored) {
                return this._clone ? this._clone(outcome.value) : outcome.value;
            }
        }
    }

    private async _fetchAndStore(
        key: K,
        fetcher: () => Promise<V>,
        ttl: Duration | undefined,
        cached: { value: V; expires: number } | undefined,
        forceStore: boolean,
    ): Promise<FetchOutcome<V>> {
        const currentEpoch = this._epoch;
        let promise: Promise<FetchOutcome<V>> | undefined;
        promise = (async (): Promise<FetchOutcome<V>> => {
            if (cached && !this._keepStaleOnError) {
                this._cache.delete(key);
                if (this._onEvict) {
                    await this._onEvict(cached.value);
                }
            }

            let value: V;
            try {
                value = await fetcher();
            } catch (err: unknown) {
                if (cached && !this._keepStaleOnError) {
                    this._cache.delete(key);
                }
                throw err;
            }

            const stillCurrent = this._promises.get(key) === promise && this._epoch === currentEpoch;
            if (stillCurrent) {
                if (cached && this._cache.peek(key) === cached && this._keepStaleOnError && this._onEvict) {
                    await this._onEvict(cached.value);
                }
                this._store(key, value, ttl);
                return { value, stored: true };
            }

            // Invalidated while fetching. If someone explicitly set a value in the
            // meantime, defer to it; otherwise either give up (caller retries) or,
            // on the final attempt, keep our value so the caller gets a live one.
            const superseded = this._cache.peek(key);
            if (!superseded && forceStore) {
                this._store(key, value, ttl);
                return { value, stored: true };
            }
            if (this._onEvict) {
                await this._onEvict(value);
            }
            return { value, stored: false };
        })();

        this._promises.set(key, promise);
        try {
            return await promise;
        } finally {
            if (this._promises.get(key) === promise) {
                this._promises.delete(key);
            }
        }
    }

    private _store(key: K, value: V, ttl: Duration | undefined): void {
        const duration = ttl ?? this._defaultTtl;
        this._cache.set(key, {
            value,
            expires: Date.now() + duration.toMilliseconds(),
        });
    }

    get(key: K): V | undefined {
        const cached = this._cache.peek(key);
        if (!cached) {
            return undefined;
        }
        if (Date.now() >= cached.expires) {
            if (!this._keepStaleOnError) {
                this._cache.delete(key);
            }
            return undefined;
        }
        const entry = this._cache.get(key);
        if (!entry) {
            return undefined;
        }
        return this._clone ? this._clone(entry.value) : entry.value;
    }

    peek(key: K): V | undefined {
        const cached = this._cache.peek(key);
        if (!cached || Date.now() >= cached.expires) {
            return undefined;
        }
        return this._clone ? this._clone(cached.value) : cached.value;
    }

    peekStale(key: K): V | undefined {
        const cached = this._cache.peek(key);
        if (!cached) {
            return undefined;
        }
        return this._clone ? this._clone(cached.value) : cached.value;
    }

    set(key: K, value: V, ttl?: Duration): void {
        this._promises.delete(key);
        const duration = ttl ?? this._defaultTtl;
        this._cache.set(key, {
            value,
            expires: Date.now() + duration.toMilliseconds(),
        });
    }

    async clear(): Promise<void> {
        this._epoch++;
        this._promises.clear();
        const entries = Array.from(this._cache.values());
        this._cache.clear();

        if (!this._onEvict || entries.length === 0) {
            return;
        }
        const onEvict = this._onEvict;
        await Promise.all(entries.map((e) => onEvict(e.value)));
    }

    async delete(key: K): Promise<boolean> {
        this._promises.delete(key);
        const cached = this._cache.peek(key);
        if (!cached) {
            return false;
        }
        this._cache.delete(key);
        if (this._onEvict) {
            await this._onEvict(cached.value);
        }
        return true;
    }

    has(key: K): boolean {
        const cached = this._cache.peek(key);
        return Boolean(cached && Date.now() < cached.expires);
    }

    get size(): number {
        return this._cache.size;
    }
}
