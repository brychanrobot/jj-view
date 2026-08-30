/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebviewTransport } from './types';

/**
 * In-Memory Mock Transport for unit tests and headless environments.
 * Buffers early incoming messages until subscribers attach.
 */
export class MockWebviewTransport implements WebviewTransport {
    public readonly sentMessages: unknown[] = [];
    private readonly handlers = new Set<(message: unknown) => void>();
    private readonly inboundQueue: unknown[] = [];

    public postMessage(message: unknown): void {
        this.sentMessages.push(message);
    }

    public onMessage(handler: (message: unknown) => void): () => void {
        this.handlers.add(handler);

        const pending = this.inboundQueue.splice(0, this.inboundQueue.length);
        for (const queued of pending) {
            this.dispatchSingle(handler, queued);
        }

        return () => {
            this.handlers.delete(handler);
        };
    }

    public simulateIncomingMessage(message: unknown): void {
        if (this.handlers.size === 0) {
            this.inboundQueue.push(message);
            return;
        }

        for (const handler of Array.from(this.handlers)) {
            this.dispatchSingle(handler, message);
        }
    }

    private dispatchSingle(handler: (message: unknown) => void, data: unknown): void {
        try {
            handler(data);
        } catch (err) {
            console.error('[MockWebviewTransport] Error in message subscriber:', err);
        }
    }

    public clear(): void {
        this.sentMessages.length = 0;
        this.handlers.clear();
        this.inboundQueue.length = 0;
    }

    public dispose(): void {
        this.clear();
    }
}
