/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebviewTransport } from './types';

/**
 * In-Memory Mock Transport for unit tests and headless environments.
 */
export class MockWebviewTransport implements WebviewTransport {
    public readonly sentMessages: unknown[] = [];
    private readonly handlers = new Set<(message: unknown) => void>();

    public postMessage(message: unknown): void {
        this.sentMessages.push(message);
    }

    public onMessage(handler: (message: unknown) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    public simulateIncomingMessage(message: unknown): void {
        for (const handler of Array.from(this.handlers)) {
            try {
                handler(message);
            } catch (err) {
                console.error('[MockWebviewTransport] Error in onMessage subscriber:', err);
            }
        }
    }

    public clear(): void {
        this.sentMessages.length = 0;
        this.handlers.clear();
    }

    public dispose(): void {
        this.clear();
    }
}
