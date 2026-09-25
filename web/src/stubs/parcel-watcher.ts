/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type BackendType = 'fs-events' | 'watchman' | 'inotify' | 'windows';

export interface AsyncSubscription {
    unsubscribe(): Promise<void>;
}

export interface WatcherEvent {
    path: string;
    type: 'create' | 'update' | 'delete';
}

export type Event = WatcherEvent;

export type SubscribeCallback = (err: Error | null, events: WatcherEvent[]) => void;

export async function subscribe(
    _dirPath: string,
    _fn: SubscribeCallback,
    _options?: unknown,
): Promise<AsyncSubscription> {
    throw new Error('@parcel/watcher is not available in browser environments.');
}
