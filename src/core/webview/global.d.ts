/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare global {
    interface Window {
        vscode?: unknown;
        __jjViewVsCodeApi?: {
            postMessage: (message: unknown) => void;
            setState?: (state: unknown) => void;
            getState?: () => unknown;
        };
        __JJ_VIEW_WS_URL__?: string;
        acquireVsCodeApi?: () => {
            postMessage: (message: unknown) => void;
            setState: (state: unknown) => void;
            getState: () => unknown;
        };
    }
}

declare module '*.svelte' {
    import type { Component } from 'svelte';
    const component: Component<Record<string, unknown>>;
    export default component;
}

export {};
