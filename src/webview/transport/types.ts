/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type WebviewTransportMessage =
    | { type: string; payload?: unknown; [key: string]: unknown }
    | { command: string; [key: string]: unknown };

export interface WebviewTransport {
    postMessage(message: unknown): void;
    onMessage(handler: (message: unknown) => void): () => void;
    getInitialData<T>(): T | undefined;
    dispose?(): void;
}
