/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { NO_OP_LOGGER, OutputChannel } from '../utils/output-channel';
import { createMockLogOutputChannel } from './test-utils';

describe('OutputChannel', () => {
    it('should delegate explicit logs correctly', () => {
        const delegate = createMockLogOutputChannel();
        const outputChannel = new OutputChannel(delegate, 'prefix');

        const infoSpy = vi.spyOn(delegate, 'info');
        const warnSpy = vi.spyOn(delegate, 'warn');
        const errorSpy = vi.spyOn(delegate, 'error');
        const debugSpy = vi.spyOn(delegate, 'debug');
        const traceSpy = vi.spyOn(delegate, 'trace');

        outputChannel.info('info message');
        expect(infoSpy).toHaveBeenCalledWith('[prefix] info message');

        outputChannel.warn('warning message');
        expect(warnSpy).toHaveBeenCalledWith('[prefix] warning message');

        outputChannel.error('error message');
        expect(errorSpy).toHaveBeenCalledWith('[prefix] error message');

        outputChannel.debug('debug message');
        expect(debugSpy).toHaveBeenCalledWith('[prefix] debug message');

        outputChannel.trace('trace message');
        expect(traceSpy).toHaveBeenCalledWith('[prefix] trace message');

        const testError = new Error('some error');
        outputChannel.error(testError.message, testError);
        expect(errorSpy).toHaveBeenCalledWith('[prefix] some error', testError);
    });

    it('should support nested prefixes and delegates', () => {
        const delegate = createMockLogOutputChannel();
        const parent = new OutputChannel(delegate, 'repo1');
        const child = new OutputChannel(parent, 'sub');

        const infoSpy = vi.spyOn(delegate, 'info');
        child.info('nested message');
        expect(infoSpy).toHaveBeenCalledWith('[repo1][sub] nested message');
    });

    it('should delegate lifecycle and UI methods', () => {
        const delegate = createMockLogOutputChannel();
        const outputChannel = new OutputChannel(delegate);

        const showSpy = vi.spyOn(delegate, 'show');
        const hideSpy = vi.spyOn(delegate, 'hide');
        const clearSpy = vi.spyOn(delegate, 'clear');
        const replaceSpy = vi.spyOn(delegate, 'replace');
        const disposeSpy = vi.spyOn(delegate, 'dispose');

        outputChannel.show(true);
        expect(showSpy).toHaveBeenCalledWith(true);

        outputChannel.hide();
        expect(hideSpy).toHaveBeenCalled();

        outputChannel.clear();
        expect(clearSpy).toHaveBeenCalled();

        outputChannel.replace('new content');
        expect(replaceSpy).toHaveBeenCalledWith('new content');

        outputChannel.dispose();
        expect(disposeSpy).toHaveBeenCalled();

        expect(outputChannel.name).toBe('Mock Log Output Channel');
    });

    it('should format logs without brackets when un-prefixed', () => {
        const delegate = createMockLogOutputChannel();
        const outputChannel = new OutputChannel(delegate);

        const infoSpy = vi.spyOn(delegate, 'info');
        const warnSpy = vi.spyOn(delegate, 'warn');
        const errorSpy = vi.spyOn(delegate, 'error');
        const debugSpy = vi.spyOn(delegate, 'debug');
        const traceSpy = vi.spyOn(delegate, 'trace');

        outputChannel.info('raw info');
        expect(infoSpy).toHaveBeenCalledWith('raw info');

        outputChannel.warn('raw warn');
        expect(warnSpy).toHaveBeenCalledWith('raw warn');

        outputChannel.debug('raw debug');
        expect(debugSpy).toHaveBeenCalledWith('raw debug');

        outputChannel.trace('raw trace');
        expect(traceSpy).toHaveBeenCalledWith('raw trace');

        const err = new Error('raw error');
        outputChannel.error('raw error msg', err);
        expect(errorSpy).toHaveBeenCalledWith('raw error msg', err);
    });

    it('should not dispose underlying delegate when called on a scoped sub-channel', () => {
        const delegate = createMockLogOutputChannel();
        const subChannel = new OutputChannel(delegate, 'repo-scope');
        const disposeSpy = vi.spyOn(delegate, 'dispose');

        subChannel.dispose();
        expect(disposeSpy).not.toHaveBeenCalled();
    });

    it('should safely no-op optional methods when delegate does not implement them', () => {
        const minimalDelegate = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        };
        const outputChannel = new OutputChannel(minimalDelegate);

        expect(() => outputChannel.trace('trace')).not.toThrow();
        expect(() => outputChannel.replace('replace')).not.toThrow();
        expect(() => outputChannel.clear()).not.toThrow();
        expect(() => outputChannel.show(false)).not.toThrow();
        expect(() => outputChannel.hide()).not.toThrow();
        expect(() => outputChannel.dispose()).not.toThrow();
        expect(outputChannel.name).toBeUndefined();
    });

    it('should verify NO_OP_LOGGER provides safe no-op implementations', () => {
        expect(() => {
            NO_OP_LOGGER.debug('msg');
            NO_OP_LOGGER.info('msg');
            NO_OP_LOGGER.warn('msg');
            NO_OP_LOGGER.error('msg', new Error('test'));
        }).not.toThrow();
    });
});
