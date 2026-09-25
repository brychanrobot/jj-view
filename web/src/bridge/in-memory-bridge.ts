/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebviewPostMessageLike } from '../../../src/core/host/webview-rpc-dispatcher';
import type { WebviewTransport } from '../../../src/core/webview/transport/types';

export interface InMemoryBridge {
    readonly messenger: WebviewPostMessageLike;
    readonly transport: WebviewTransport;
}

export function createInMemoryBridge(handler?: (message: unknown) => Promise<unknown> | unknown): InMemoryBridge {
    const listeners = new Set<(message: unknown) => void>();

    const messenger: WebviewPostMessageLike = {
        postMessage: (message: unknown) => {
            for (const listener of listeners) {
                listener(message);
            }
        },
    };

    const transport: WebviewTransport = {
        postMessage: (message: unknown) => {
            if (handler) {
                void handler(message);
            }
        },
        onMessage: (listener: (message: unknown) => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose: () => {
            listeners.clear();
        },
    };

    return { messenger, transport };
}
