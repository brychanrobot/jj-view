/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { WebviewInitialData } from '../jj-types';

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
