import { WebviewInitialData } from '../jj-types';

/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Globals provided by the webview host
export {};

declare global {
    interface Window {
        vscode: unknown;
        vscodeInitialData?: WebviewInitialData;
        acquireVsCodeApi: () => {
            postMessage: (message: { type: string; payload?: unknown }) => void;
            setState: (state: unknown) => void;
            getState: () => unknown;
        };
    }
}
