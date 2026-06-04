/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Disposable } from 'vscode';

export class AsyncEventEmitter<T> {
    private readonly listeners: ((event: T) => Promise<void> | void)[] = [];

    event = (listener: (event: T) => Promise<void> | void): Disposable => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                const index = this.listeners.indexOf(listener);
                if (index !== -1) {
                    this.listeners.splice(index, 1);
                }
            },
        };
    };

    async fire(event: T): Promise<void> {
        const promises = this.listeners.map(async (listener) => {
            try {
                await listener(event);
            } catch (err) {
                console.error('Error in AsyncEventEmitter listener:', err);
            }
        });
        await Promise.all(promises);
    }
}
