/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, test, vi } from 'vitest';
import { WebviewLogger, type WebviewVsCodeApi } from '../webview/webview-logger';

describe('WebviewLogger', () => {
    test('logs error to console and posts logMessage to vscodeApi', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const mockVscodeApi: WebviewVsCodeApi = {
            postMessage: vi.fn(),
        };

        const logger = new WebviewLogger('TestTag', mockVscodeApi);
        const err = new Error('Test failure');

        logger.error('Something failed', err);

        expect(consoleSpy).toHaveBeenCalledWith('[TestTag] Something failed', err);

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: 'logMessage',
            payload: {
                level: 'error',
                message: '[TestTag] Something failed',
                details: expect.stringContaining('Test failure'),
            },
        });

        consoleSpy.mockRestore();
    });

    test('logs info and warn to console and posts logMessage to vscodeApi', () => {
        const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mockVscodeApi: WebviewVsCodeApi = {
            postMessage: vi.fn(),
        };

        const logger = new WebviewLogger('TestTag', mockVscodeApi);

        logger.info('Info message', 'details-info');
        logger.warn('Warn message', 'details-warn');

        expect(consoleInfoSpy).toHaveBeenCalledWith('[TestTag] Info message', 'details-info');
        expect(consoleWarnSpy).toHaveBeenCalledWith('[TestTag] Warn message', 'details-warn');

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: 'logMessage',
            payload: {
                level: 'info',
                message: '[TestTag] Info message',
                details: 'details-info',
            },
        });

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: 'logMessage',
            payload: {
                level: 'warn',
                message: '[TestTag] Warn message',
                details: 'details-warn',
            },
        });

        consoleInfoSpy.mockRestore();
        consoleWarnSpy.mockRestore();
    });

    test('works gracefully when vscodeApi is undefined', () => {
        const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const logger = new WebviewLogger('TestTag');

        logger.info('Standalone info message');

        expect(consoleInfoSpy).toHaveBeenCalledWith('[TestTag] Standalone info message', '');
        consoleInfoSpy.mockRestore();
    });
});
