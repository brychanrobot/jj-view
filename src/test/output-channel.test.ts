/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { JjOutputChannel } from '../utils/output-channel';
import { createMockLogOutputChannel } from './test-utils';

describe('JjOutputChannel', () => {
    it('should delegate explicit logs correctly', () => {
        const delegate = createMockLogOutputChannel();
        const outputChannel = new JjOutputChannel(delegate, 'prefix');

        const infoSpy = vi.spyOn(delegate, 'info');
        const warnSpy = vi.spyOn(delegate, 'warn');
        const errorSpy = vi.spyOn(delegate, 'error');
        const debugSpy = vi.spyOn(delegate, 'debug');

        // Explicit logs should delegate correctly
        outputChannel.info('info message');
        expect(infoSpy).toHaveBeenCalledWith('[prefix] info message');

        outputChannel.warn('warning message');
        expect(warnSpy).toHaveBeenCalledWith('[prefix] warning message');

        outputChannel.error('error message');
        expect(errorSpy).toHaveBeenCalledWith('[prefix] error message');

        outputChannel.debug('debug message');
        expect(debugSpy).toHaveBeenCalledWith('[prefix] debug message');

        // Error object should preserve original instance and custom properties
        const testError = new Error('some error') as Error & { code: string };
        testError.code = 'ERR_TEST';
        outputChannel.error(testError);
        expect(errorSpy).toHaveBeenCalledWith('[prefix] some error', testError);
    });
});
