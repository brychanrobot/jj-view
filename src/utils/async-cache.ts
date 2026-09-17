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
}

export class AsyncCache<K = string, V = unknown> {
    private readonly _cache: LruCache<K, { value: V; expires: number }>;
    private readonly _promises = new Map<K, Promise<V>>();
    private readonly _defaultTtl: Duration;
    private readonly _onEvict?: (value: V) => Promise<void> | void;
    private readonly _clone?: (value: V) => V;

    private _epoch = 0;

    constructor(options: AsyncCacheOptions<V> = {}) {
        this._defaultTtl =
            options.ttl ?? (options.ttlMs !== undefined ? Duration.milliseconds(options.ttlMs) : Duration.INFINITY);
        this._onEvict = options.onEvict;
        this._clone = options.clone;

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

    async getOrFetch(key: K, fetcher: () => Promise<V>, ttl?: Duration): Promise<V> {
        const inProgress = this._promises.get(key);
        if (inProgress) {
            const val = await inProgress;
            return this._clone ? this._clone(val) : val;
        }

        const cached = this._cache.peek(key);
        if (cached && Date.now() < cached.expires) {
            const entry = this._cache.get(key);
            if (entry) {
                return this._clone ? this._clone(entry.value) : entry.value;
            }
        }

        const currentEpoch = this._epoch;
        let promise: Promise<V> | undefined;
        promise = (async () => {
            if (cached) {
                this._cache.delete(key);
                if (this._onEvict) {
                    await this._onEvict(cached.value);
                }
            }

            let value: V;
            try {
                value = await fetcher();
            } catch (err: unknown) {
                if (cached) {
                    this._cache.delete(key);
                }
                throw err;
            }

            if (this._promises.get(key) === promise && this._epoch === currentEpoch) {
                const duration = ttl ?? this._defaultTtl;
                this._cache.set(key, {
                    value,
                    expires: Date.now() + duration.toMilliseconds(),
                });
            } else if (this._onEvict) {
                await this._onEvict(value);
            }
            return value;
        })();

        this._promises.set(key, promise);
        try {
            const val = await promise;
            return this._clone ? this._clone(val) : val;
        } finally {
            if (this._promises.get(key) === promise) {
                this._promises.delete(key);
            }
        }
    }

    get(key: K): V | undefined {
        const cached = this._cache.peek(key);
        if (!cached) {
            return undefined;
        }
        if (Date.now() >= cached.expires) {
            this._cache.delete(key);
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
