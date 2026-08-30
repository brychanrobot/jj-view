/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MockWebviewTransport } from './mock-transport';
import type { WebviewTransport } from './types';
import { VsCodeWebviewTransport } from './vscode-transport';

import { WebSocketWebviewTransport } from './websocket-transport';

let defaultTransport: WebviewTransport | undefined;

/**
 * Retrieves or creates the default singleton transport for the active runtime.
 */
export function getWebviewTransport(): WebviewTransport {
    if (defaultTransport) {
        return defaultTransport;
    }

    if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
        defaultTransport = new VsCodeWebviewTransport();
    } else if (
        typeof window !== 'undefined' &&
        (window.__JJ_VIEW_WS_URL__ ||
            (window.location && typeof window.location.host === 'string' && window.location.host.length > 0))
    ) {
        const wsProtocol = window.location?.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = window.__JJ_VIEW_WS_URL__ ?? `${wsProtocol}//${window.location?.host}/ws`;
        defaultTransport = new WebSocketWebviewTransport(wsUrl);
    } else {
        defaultTransport = new MockWebviewTransport();
    }

    return defaultTransport;
}

/**
 * Overrides the default transport singleton (useful for testing or standalone web bootstrapping).
 */
export function setWebviewTransport(transport: WebviewTransport | undefined): void {
    if (defaultTransport && defaultTransport !== transport) {
        defaultTransport.dispose?.();
    }
    defaultTransport = transport;
}
