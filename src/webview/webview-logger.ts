/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WebviewVsCodeApi {
    postMessage(message: unknown): void;
}

export class WebviewLogger {
    constructor(
        private readonly tag: string,
        private readonly vscodeApi?: WebviewVsCodeApi,
    ) {}

    public info(message: string, details?: unknown): void {
        console.info(`[${this.tag}] ${message}`, details ?? '');
        this.post('info', message, details);
    }

    public warn(message: string, details?: unknown): void {
        console.warn(`[${this.tag}] ${message}`, details ?? '');
        this.post('warn', message, details);
    }

    public error(message: string, error?: unknown): void {
        console.error(`[${this.tag}] ${message}`, error ?? '');
        this.post('error', message, error);
    }

    private post(level: 'info' | 'warn' | 'error', message: string, details?: unknown): void {
        if (!this.vscodeApi) {
            return;
        }
        const detailStr =
            details instanceof Error
                ? details.stack || details.message
                : details !== undefined
                  ? String(details)
                  : undefined;

        this.vscodeApi.postMessage({
            type: 'logMessage',
            payload: {
                level,
                message: `[${this.tag}] ${message}`,
                details: detailStr,
            },
        });
    }
}
