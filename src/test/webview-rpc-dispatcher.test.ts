/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createWebviewRpcClient, createWebviewRpcDispatcher } from '../common/webview-rpc-dispatcher';

describe('WebviewRpcDispatcher', () => {
    const testSchema = z.discriminatedUnion('type', [
        z.object({ type: z.literal('ping'), value: z.string() }),
        z.object({ type: z.literal('count'), amount: z.number() }),
    ]);

    test('dispatches valid messages to their registered handlers', async () => {
        const pingFn = vi.fn();
        const countFn = vi.fn();

        const dispatcher = createWebviewRpcDispatcher(testSchema, {
            ping: pingFn,
            count: countFn,
        });

        const handledPing = await dispatcher.dispatch({ type: 'ping', value: 'hello' });
        expect(handledPing).toBe(true);
        expect(pingFn).toHaveBeenCalledWith({ type: 'ping', value: 'hello' });
        expect(countFn).not.toHaveBeenCalled();

        const handledCount = await dispatcher.dispatch({ type: 'count', amount: 42 });
        expect(handledCount).toBe(true);
        expect(countFn).toHaveBeenCalledWith({ type: 'count', amount: 42 });
    });

    test('returns false and ignores invalid messages', async () => {
        const pingFn = vi.fn();
        const countFn = vi.fn();

        const dispatcher = createWebviewRpcDispatcher(testSchema, {
            ping: pingFn,
            count: countFn,
        });

        const invalidType = await dispatcher.dispatch({ type: 'unknown' });
        expect(invalidType).toBe(false);

        const invalidPayload = await dispatcher.dispatch({ type: 'count', amount: 'not a number' });
        expect(invalidPayload).toBe(false);

        const nonObject = await dispatcher.dispatch('just a string');
        expect(nonObject).toBe(false);

        expect(pingFn).not.toHaveBeenCalled();
        expect(countFn).not.toHaveBeenCalled();
    });

    test('supports custom discriminator keys', async () => {
        const customSchema = z.discriminatedUnion('command', [
            z.object({ command: z.literal('open'), path: z.string() }),
            z.object({ command: z.literal('close') }),
        ]);

        const openFn = vi.fn();
        const closeFn = vi.fn();

        const dispatcher = createWebviewRpcDispatcher(
            customSchema,
            {
                open: openFn,
                close: closeFn,
            },
            { discriminatorKey: 'command' },
        );

        const handled = await dispatcher.dispatch({ command: 'open', path: '/foo' });
        expect(handled).toBe(true);
        expect(openFn).toHaveBeenCalledWith({ command: 'open', path: '/foo' });
    });

    test('automatically dispatches baseline logMessage to logger', async () => {
        const mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        };

        const dispatcher = createWebviewRpcDispatcher(testSchema, {}, { logger: mockLogger });

        const infoHandled = await dispatcher.dispatch({
            type: 'logMessage',
            payload: { level: 'info', message: 'Ready', details: 'Initialized' },
        });
        expect(infoHandled).toBe(true);
        expect(mockLogger.info).toHaveBeenCalledWith('Ready: Initialized');

        const warnHandled = await dispatcher.dispatch({
            type: 'logMessage',
            payload: { level: 'warn', message: 'Caution' },
        });
        expect(warnHandled).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith('Caution');

        const errHandled = await dispatcher.dispatch({
            type: 'logMessage',
            payload: { level: 'error', message: 'Failure', details: 'Details' },
        });
        expect(errHandled).toBe(true);
        expect(mockLogger.error).toHaveBeenCalledWith('Failure: Details');
    });

    test('dispatches custom logMessage handler with raw message', async () => {
        const customLogMessageHandler = vi.fn(async (_message) => {
            await Promise.resolve();
        });

        const rawLogMessage = {
            type: 'logMessage',
            payload: { level: 'info', message: 'custom log message' },
        };

        const dispatcher = createWebviewRpcDispatcher(
            testSchema,
            {
                logMessage: customLogMessageHandler,
            } as never,
            {},
        );

        const handled = await dispatcher.dispatch(rawLogMessage);

        expect(handled).toBe(true);
        expect(customLogMessageHandler).toHaveBeenCalledTimes(1);
        expect(customLogMessageHandler).toHaveBeenCalledWith(rawLogMessage);
    });
});

describe('createWebviewRpcClient', () => {
    const testSchema = z.discriminatedUnion('type', [
        z.object({ type: z.literal('ping'), value: z.string() }),
        z.object({ type: z.literal('count'), amount: z.number() }),
    ]);

    test('invokes webview.postMessage with type and payload', () => {
        const mockWebview = {
            postMessage: vi.fn().mockReturnValue(Promise.resolve(true)),
        };

        const client = createWebviewRpcClient(mockWebview, testSchema);

        client.ping({ value: 'hello' });
        expect(mockWebview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'ping',
                value: 'hello',
            }),
        );

        client.count({ amount: 10 });
        expect(mockWebview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'count',
                amount: 10,
            }),
        );
    });

    test('validates payload against Zod schema and throws on invalid structure', () => {
        const mockWebview = {
            postMessage: vi.fn().mockReturnValue(Promise.resolve(true)),
        };

        const client = createWebviewRpcClient(mockWebview, testSchema);

        // @ts-expect-error testing invalid payload type at runtime
        expect(() => client.count({ amount: 'invalid' })).toThrowError(/Invalid RPC message 'count'/);
        expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });

    test('supports request-response promise resolution and exception propagation', async () => {
        const rpcSchema = z.discriminatedUnion('type', [
            z.object({ type: z.literal('greet'), name: z.string(), requestId: z.string().optional() }),
            z.object({ type: z.literal('fail'), requestId: z.string().optional() }),
        ]);

        const messenger = {
            postMessage: vi.fn((msg) => {
                dispatcher.dispatch(msg);
                return Promise.resolve(true);
            }),
        };

        const dispatcher = createWebviewRpcDispatcher(
            rpcSchema,
            {
                greet: async (msg) => `Hello ${msg.name}`,
                fail: async () => {
                    throw new Error('Something went wrong');
                },
            },
            { messenger },
        );

        const client = createWebviewRpcClient(messenger, rpcSchema, { dispatcher });

        const greeting = await client.greet({ name: 'Alice' });
        expect(greeting).toBe('Hello Alice');

        await expect(client.fail()).rejects.toThrowError('Something went wrong');
    });
});
