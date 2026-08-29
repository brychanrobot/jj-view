/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebviewTransport } from './types';

/**
 * VS Code Webview Transport using window.acquireVsCodeApi() and window message events.
 */
export class VsCodeWebviewTransport implements WebviewTransport {
    private readonly vscodeApi: {
        postMessage: (message: unknown) => void;
        setState?: (state: unknown) => void;
        getState?: () => unknown;
    };
    private readonly _listeners = new Set<(event: MessageEvent) => void>();

    constructor() {
        if (typeof window === 'undefined' || typeof window.acquireVsCodeApi !== 'function') {
            this.vscodeApi = {
                postMessage: () => {},
            };
            return;
        }

        if (!window.__jjViewVsCodeApi) {
            window.__jjViewVsCodeApi = window.acquireVsCodeApi();
        }
        this.vscodeApi = window.__jjViewVsCodeApi;
    }

    public postMessage(message: unknown): void {
        this.vscodeApi.postMessage(message);
    }

    public onMessage(handler: (message: unknown) => void): () => void {
        if (typeof window === 'undefined') {
            return () => {};
        }

        const listener = (event: MessageEvent) => {
            try {
                handler(event.data);
            } catch (err) {
                console.error('[VsCodeWebviewTransport] Error in onMessage subscriber:', err);
            }
        };

        this._listeners.add(listener);
        window.addEventListener('message', listener);
        return () => {
            this._listeners.delete(listener);
            window.removeEventListener('message', listener);
        };
    }

    public dispose(): void {
        if (typeof window !== 'undefined') {
            for (const listener of this._listeners) {
                window.removeEventListener('message', listener);
            }
        }
        this._listeners.clear();
    }
}
