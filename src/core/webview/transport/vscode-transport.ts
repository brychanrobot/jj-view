/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebviewTransport } from './types';

/**
 * VS Code Webview Transport using window.acquireVsCodeApi() and window message events.
 * Automatically buffers early inbound messages until handlers subscribe.
 */
export class VsCodeWebviewTransport implements WebviewTransport {
    private readonly vscodeApi: {
        postMessage: (message: unknown) => void;
        setState?: (state: unknown) => void;
        getState?: () => unknown;
    };
    private readonly _handlers = new Set<(message: unknown) => void>();
    private readonly _inboundQueue: unknown[] = [];
    private readonly _windowListener?: (event: MessageEvent) => void;

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

        if (typeof window.addEventListener === 'function') {
            this._windowListener = (event: MessageEvent) => {
                this._handleIncomingMessage(event.data);
            };
            window.addEventListener('message', this._windowListener);
        }
    }

    private _handleIncomingMessage(data: unknown): void {
        if (this._handlers.size === 0) {
            this._inboundQueue.push(data);
            return;
        }

        for (const handler of Array.from(this._handlers)) {
            this._dispatchSingle(handler, data);
        }
    }

    private _dispatchSingle(handler: (message: unknown) => void, data: unknown): void {
        try {
            handler(data);
        } catch (err) {
            console.error('[VsCodeWebviewTransport] Error in message handler:', err);
        }
    }

    public postMessage(message: unknown): void {
        this.vscodeApi.postMessage(message);
    }

    public onMessage(handler: (message: unknown) => void): () => void {
        this._handlers.add(handler);

        const pending = this._inboundQueue.splice(0, this._inboundQueue.length);
        for (const queued of pending) {
            this._dispatchSingle(handler, queued);
        }

        return () => {
            this._handlers.delete(handler);
        };
    }

    public dispose(): void {
        if (typeof window !== 'undefined' && this._windowListener) {
            window.removeEventListener('message', this._windowListener);
        }
        this._handlers.clear();
        this._inboundQueue.length = 0;
    }
}
