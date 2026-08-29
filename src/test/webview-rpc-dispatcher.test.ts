/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createWebviewRpcClient, createWebviewRpcDispatcher } from '../common/webview-rpc-dispatcher';
import type { LoggerChannel } from '../utils/output-channel';

describe('WebviewRpcDispatcher', () => {
    const testSchema = z.discriminatedUnion('type', [
        z.object({ type: z.literal('ping'), payload: z.object({ value: z.string() }) }),
        z.object({ type: z.literal('count'), payload: z.object({ amount: z.number() }) }),
    ]);

    test('dispatches valid messages to their registered handlers delivering unwrapped payload', async () => {
        const pingFn = vi.fn();
        const countFn = vi.fn();

        const dispatcher = createWebviewRpcDispatcher(testSchema, {
            ping: pingFn,
            count: countFn,
        });

        const handledPing = await dispatcher.dispatch({ type: 'ping', payload: { value: 'hello' } });
        expect(handledPing).toBe(true);
        expect(pingFn).toHaveBeenCalledWith({ value: 'hello' });
        expect(countFn).not.toHaveBeenCalled();

        const handledCount = await dispatcher.dispatch({ type: 'count', payload: { amount: 42 } });
        expect(handledCount).toBe(true);
        expect(countFn).toHaveBeenCalledWith({ amount: 42 });
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

        const invalidPayload = await dispatcher.dispatch({ type: 'count', payload: { amount: 'not a number' } });
        expect(invalidPayload).toBe(false);

        const nonObject = await dispatcher.dispatch('just a string');
        expect(nonObject).toBe(false);

        expect(pingFn).not.toHaveBeenCalled();
        expect(countFn).not.toHaveBeenCalled();
    });

    test('supports custom discriminator keys', async () => {
        const customSchema = z.discriminatedUnion('command', [
            z.object({ command: z.literal('open'), payload: z.object({ path: z.string() }) }),
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

        const handled = await dispatcher.dispatch({ command: 'open', payload: { path: '/foo' } });
        expect(handled).toBe(true);
        expect(openFn).toHaveBeenCalledWith({ path: '/foo' });

        const handledClose = await dispatcher.dispatch({ command: 'close' });
        expect(handledClose).toBe(true);
        expect(closeFn).toHaveBeenCalledTimes(1);
    });

    test('automatically dispatches baseline logMessage to logger', async () => {
        const mockLogger: LoggerChannel = {
            debug: vi.fn(),
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

    test('logs error and invokes onError on validation failure for known message types', async () => {
        const mockLogger: LoggerChannel = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        };
        const onError = vi.fn();

        const dispatcher = createWebviewRpcDispatcher(testSchema, { ping: vi.fn() }, { logger: mockLogger, onError });

        const invalidMsg = { type: 'count', payload: { amount: 'not a number' } };
        const result = await dispatcher.dispatch(invalidMsg);

        expect(result).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith('Webview RPC validation failed', expect.any(Error));
        expect(onError).toHaveBeenCalledWith(expect.any(Error), invalidMsg);
    });

    test('logs error and invokes onError when handler throws', async () => {
        const mockLogger: LoggerChannel = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        };
        const onError = vi.fn();
        const handlerError = new Error('Handler crash');

        const dispatcher = createWebviewRpcDispatcher(
            testSchema,
            {
                ping: () => {
                    throw handlerError;
                },
            },
            { logger: mockLogger, onError },
        );

        const validMsg = { type: 'ping', payload: { value: 'boom' } };
        const result = await dispatcher.dispatch(validMsg);

        expect(result).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith('Webview RPC handler error (ping)', handlerError);
        expect(onError).toHaveBeenCalledWith(handlerError, validMsg);
    });

    test('sends error response when message has requestId but no handler is registered', async () => {
        const mockPostMessage = vi.fn();
        const schemaWithReq = z.discriminatedUnion('type', [
            z.object({
                type: z.literal('ping'),
                payload: z.object({ value: z.string() }),
                requestId: z.string().optional(),
            }),
        ]);

        const dispatcher = createWebviewRpcDispatcher(
            schemaWithReq,
            {},
            { messenger: { postMessage: mockPostMessage } },
        );

        const handled = await dispatcher.dispatch({
            type: 'ping',
            payload: { value: 'test' },
            requestId: 'req_unregistered',
        });
        expect(handled).toBe(false);
        expect(mockPostMessage).toHaveBeenCalledWith({
            type: '__rpc_response__',
            requestId: 'req_unregistered',
            error: "No handler registered for 'ping'",
        });
    });

    test('rejects pending requests when dispatcher is disposed', async () => {
        const dispatcher = createWebviewRpcDispatcher(testSchema, {});
        const pending = dispatcher.registerPendingRequest('req_123');

        dispatcher.dispose();

        await expect(pending).rejects.toThrowError('WebviewRpcDispatcher disposed');
    });

    test('dispatches custom logMessage handler with payload', async () => {
        const customLogMessageHandler = vi.fn(async (_message) => {
            await Promise.resolve();
        });

        const schemaWithLog = z.discriminatedUnion('type', [
            z.object({ type: z.literal('ping'), payload: z.object({ value: z.string() }) }),
            z.object({
                type: z.literal('logMessage'),
                payload: z.object({ level: z.enum(['info', 'warn', 'error']), message: z.string() }),
            }),
        ]);

        const rawLogMessage = {
            type: 'logMessage' as const,
            payload: { level: 'info' as const, message: 'custom log message' },
        };

        const dispatcher = createWebviewRpcDispatcher(schemaWithLog, {
            logMessage: customLogMessageHandler,
        });

        const handled = await dispatcher.dispatch(rawLogMessage);

        expect(handled).toBe(true);
        expect(customLogMessageHandler).toHaveBeenCalledTimes(1);
        expect(customLogMessageHandler).toHaveBeenCalledWith(rawLogMessage.payload);
    });

    test('buffers outbound messages before messenger attaches and flushes in order on addMessenger', () => {
        const dispatcher = createWebviewRpcDispatcher(testSchema, {});
        expect(dispatcher.hasMessengers).toBe(false);

        dispatcher.broadcast({ type: 'queued1' });
        dispatcher.broadcast({ type: 'queued2' });

        const messenger = {
            postMessage: vi.fn(),
        };

        const sub = dispatcher.addMessenger(messenger);
        expect(dispatcher.hasMessengers).toBe(true);
        expect(messenger.postMessage).toHaveBeenCalledTimes(2);
        expect(messenger.postMessage).toHaveBeenNthCalledWith(1, { type: 'queued1' });
        expect(messenger.postMessage).toHaveBeenNthCalledWith(2, { type: 'queued2' });

        dispatcher.broadcast({ type: 'immediate' });
        expect(messenger.postMessage).toHaveBeenCalledTimes(3);
        expect(messenger.postMessage).toHaveBeenNthCalledWith(3, { type: 'immediate' });

        sub.dispose();
        expect(dispatcher.hasMessengers).toBe(false);
    });

    test('sends initial state upon messenger attachment and on webviewLoaded handshake', async () => {
        let currentState = { count: 1 };
        const dispatcher = createWebviewRpcDispatcher(
            testSchema,
            {
                ping: vi.fn(),
            },
            {
                getInitialState: () => ({ type: 'snapshot', count: currentState.count }),
            },
        );

        const messenger = {
            postMessage: vi.fn(),
        };

        dispatcher.addMessenger(messenger);
        expect(messenger.postMessage).toHaveBeenCalledWith({ type: 'snapshot', count: 1 });

        currentState = { count: 2 };
        await dispatcher.dispatch({ type: 'webviewLoaded' });
        expect(messenger.postMessage).toHaveBeenCalledWith({ type: 'snapshot', count: 2 });
    });

    test('supports getState returning state payload directly', () => {
        const dispatcher = createWebviewRpcDispatcher(
            testSchema,
            {},
            {
                getState: () => ({
                    commits: ['c1', 'c2'],
                    theme: 'dark',
                }),
            },
        );

        const messenger = {
            postMessage: vi.fn(),
        };

        dispatcher.addMessenger(messenger);
        expect(messenger.postMessage).toHaveBeenCalledTimes(1);
        expect(messenger.postMessage).toHaveBeenCalledWith({
            type: 'update',
            payload: { commits: ['c1', 'c2'], theme: 'dark' },
        });
    });

    test('supports getInitialState returning keyed InitialStateMap', () => {
        const dispatcher = createWebviewRpcDispatcher(
            testSchema,
            {},
            {
                getInitialState: () => ({
                    update: { commits: ['c1', 'c2'] },
                    skipped: undefined,
                }),
            },
        );

        const messenger = {
            postMessage: vi.fn(),
        };

        dispatcher.addMessenger(messenger);
        expect(messenger.postMessage).toHaveBeenCalledTimes(1);
        expect(messenger.postMessage).toHaveBeenCalledWith({
            type: 'update',
            payload: { commits: ['c1', 'c2'] },
        });
    });

    test('supports setMessenger to replace active messenger and flush queues', () => {
        const dispatcher = createWebviewRpcDispatcher(testSchema, {});

        const messenger1 = { postMessage: vi.fn() };
        dispatcher.setMessenger(messenger1);
        expect(dispatcher.hasMessengers).toBe(true);

        dispatcher.broadcast({ type: 'msg1' });
        expect(messenger1.postMessage).toHaveBeenCalledWith({ type: 'msg1' });

        const messenger2 = { postMessage: vi.fn() };
        dispatcher.setMessenger(messenger2);

        dispatcher.broadcast({ type: 'msg2' });
        expect(messenger1.postMessage).not.toHaveBeenCalledWith({ type: 'msg2' });
        expect(messenger2.postMessage).toHaveBeenCalledWith({ type: 'msg2' });

        dispatcher.setMessenger(undefined);
        expect(dispatcher.hasMessengers).toBe(false);
    });

    test('broadcasts to multiple simultaneous messengers and handles selective disposal', () => {
        const dispatcher = createWebviewRpcDispatcher(testSchema, {});
        const messengerA = { postMessage: vi.fn() };
        const messengerB = { postMessage: vi.fn() };

        const subA = dispatcher.addMessenger(messengerA);
        const subB = dispatcher.addMessenger(messengerB);
        expect(dispatcher.hasMessengers).toBe(true);

        dispatcher.broadcast({ type: 'multi1' });
        expect(messengerA.postMessage).toHaveBeenCalledWith({ type: 'multi1' });
        expect(messengerB.postMessage).toHaveBeenCalledWith({ type: 'multi1' });

        subA.dispose();
        expect(dispatcher.hasMessengers).toBe(true);

        dispatcher.broadcast({ type: 'multi2' });
        expect(messengerA.postMessage).not.toHaveBeenCalledWith({ type: 'multi2' });
        expect(messengerB.postMessage).toHaveBeenCalledWith({ type: 'multi2' });

        subB.dispose();
        expect(dispatcher.hasMessengers).toBe(false);
    });

    test('enforces maxQueueSize on outbound message buffer', () => {
        const dispatcher = createWebviewRpcDispatcher(testSchema, {}, { maxQueueSize: 2 });
        dispatcher.broadcast({ type: 'msg1' });
        dispatcher.broadcast({ type: 'msg2' });
        dispatcher.broadcast({ type: 'msg3' });

        const messenger = { postMessage: vi.fn() };
        dispatcher.addMessenger(messenger);

        expect(messenger.postMessage).toHaveBeenCalledTimes(2);
        expect(messenger.postMessage).toHaveBeenNthCalledWith(1, { type: 'msg2' });
        expect(messenger.postMessage).toHaveBeenNthCalledWith(2, { type: 'msg3' });
    });

    test('handles getInitialState returning array of messages or undefined', async () => {
        let stateMode = 'array';
        const dispatcher = createWebviewRpcDispatcher(
            testSchema,
            {},
            {
                getInitialState: () => {
                    if (stateMode === 'undefined') {
                        return undefined;
                    }
                    return [{ type: 'item1' }, undefined, { type: 'item2' }];
                },
            },
        );

        const messenger = { postMessage: vi.fn() };
        dispatcher.addMessenger(messenger);

        expect(messenger.postMessage).toHaveBeenCalledTimes(2);
        expect(messenger.postMessage).toHaveBeenNthCalledWith(1, { type: 'item1' });
        expect(messenger.postMessage).toHaveBeenNthCalledWith(2, { type: 'item2' });

        messenger.postMessage.mockClear();
        stateMode = 'undefined';
        await dispatcher.dispatch({ type: 'webviewLoaded' });
        expect(messenger.postMessage).not.toHaveBeenCalled();
    });

    test('sends RPC error response when known command fails payload validation', async () => {
        const messenger = { postMessage: vi.fn() };
        const dispatcher = createWebviewRpcDispatcher(testSchema, { count: vi.fn() }, { messenger });

        const result = await dispatcher.dispatch({
            type: 'count',
            requestId: 'req_val_err',
            payload: { amount: 'invalid_type' },
        });

        expect(result).toBe(false);
        expect(messenger.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: '__rpc_response__',
                requestId: 'req_val_err',
                error: expect.stringContaining('Validation failed'),
            }),
        );
    });

    test('guards against operations after disposal', async () => {
        const dispatcher = createWebviewRpcDispatcher(testSchema, { ping: vi.fn() });
        dispatcher.dispose();
        expect(dispatcher.isDisposed).toBe(true);

        dispatcher.broadcast({ type: 'ping', payload: { value: 'test' } });
        const handled = await dispatcher.dispatch({ type: 'ping', payload: { value: 'test' } });
        expect(handled).toBe(false);

        await expect(dispatcher.registerPendingRequest('req_after_dispose')).rejects.toThrowError(
            'WebviewRpcDispatcher is disposed',
        );

        const sub = dispatcher.addMessenger({ postMessage: vi.fn() });
        expect(dispatcher.hasMessengers).toBe(false);
        sub.dispose();
    });

    test('supports typed emitter proxy for broadcasting messages', () => {
        type OutboundEvents =
            | { type: 'update'; payload: { count: number } }
            | { type: 'reset' }
            | { type: 'notify'; payload: { message: string } };

        const dispatcher = createWebviewRpcDispatcher<z.infer<typeof testSchema>, OutboundEvents>(testSchema, {});

        const messenger = { postMessage: vi.fn() };
        dispatcher.addMessenger(messenger);

        dispatcher.emitter.update({ count: 42 });
        expect(messenger.postMessage).toHaveBeenCalledWith({
            type: 'update',
            payload: { count: 42 },
        });

        dispatcher.emitter.reset();
        expect(messenger.postMessage).toHaveBeenCalledWith({
            type: 'reset',
        });

        dispatcher.emitter.notify({ message: 'hello' });
        expect(messenger.postMessage).toHaveBeenCalledWith({
            type: 'notify',
            payload: { message: 'hello' },
        });

        const dynamicEmitter = dispatcher.emitter as Record<string | symbol, unknown>;
        expect(dynamicEmitter.then).toBeUndefined();
        expect(dynamicEmitter.toJSON).toBeUndefined();
        expect(dynamicEmitter.constructor).toBeUndefined();
        expect(dynamicEmitter[Symbol.iterator]).toBeUndefined();
    });
});

describe('createWebviewRpcClient', () => {
    const testSchema = z.discriminatedUnion('type', [
        z.object({ type: z.literal('ping'), payload: z.object({ value: z.string() }) }),
        z.object({ type: z.literal('count'), payload: z.object({ amount: z.number() }) }),
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
                payload: { value: 'hello' },
            }),
        );

        client.count({ amount: 10 });
        expect(mockWebview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'count',
                payload: { amount: 10 },
            }),
        );
    });

    test('validates payload against Zod schema and throws on invalid structure', () => {
        const mockWebview = {
            postMessage: vi.fn().mockReturnValue(Promise.resolve(true)),
        };

        const client = createWebviewRpcClient(mockWebview, testSchema);
        const untypedCount = client.count as (payload: Record<string, unknown>) => Promise<unknown>;

        expect(() => untypedCount({ amount: 'invalid' })).toThrowError(/Invalid RPC message 'count'/);
        expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });

    test('supports request-response promise resolution and exception propagation', async () => {
        const rpcSchema = z.discriminatedUnion('type', [
            z.object({
                type: z.literal('greet'),
                payload: z.object({ name: z.string() }),
                requestId: z.string().optional(),
            }),
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
                greet: async ({ name }) => `Hello ${name}`,
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

    test('ignores then, toJSON, constructor, and symbol properties on client proxy', () => {
        const mockWebview = { postMessage: vi.fn() };
        const client = createWebviewRpcClient(mockWebview, testSchema);
        const dynamicClient = client as Record<string | symbol, unknown>;

        expect(dynamicClient.then).toBeUndefined();
        expect(dynamicClient.toJSON).toBeUndefined();
        expect(dynamicClient.constructor).toBeUndefined();
        expect(dynamicClient[Symbol.iterator]).toBeUndefined();
        expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });

    test('unregisters pending request when webview.postMessage throws synchronously', () => {
        const unregisterSpy = vi.fn();
        const mockDispatcher = {
            registerPendingRequest: vi.fn().mockReturnValue(new Promise(() => {})),
            unregisterPendingRequest: unregisterSpy,
        };

        const errorWebview = {
            postMessage: () => {
                throw new Error('Transport write failure');
            },
        };

        const client = createWebviewRpcClient(errorWebview, testSchema, {
            dispatcher: mockDispatcher,
        });

        expect(() => client.ping({ value: 'fail' })).toThrowError('Transport write failure');
        expect(unregisterSpy).toHaveBeenCalledWith(expect.stringMatching(/^req_/));
    });
});
