/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as React from 'react';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { z } from 'zod';
import {
    createWebviewRpcReceiver,
    createWebviewRpcSender,
    type DiscriminatedMessage,
    type RpcReceiverHandlers,
    type RpcSenderMethods,
    type WebviewRpcReceiverOptions,
    type WebviewRpcSenderOptions,
} from '../../common/webview-rpc-dispatcher';
import { getWebviewTransport } from './registry';
import type { WebviewTransport } from './types';

const BridgeContext = createContext<WebviewTransport | null>(null);

export interface BridgeProviderProps {
    transport?: WebviewTransport;
    children: React.ReactNode;
}

export const BridgeProvider: React.FC<BridgeProviderProps> = ({ transport, children }) => {
    const activeTransport = useMemo(() => transport ?? getWebviewTransport(), [transport]);

    return <BridgeContext.Provider value={activeTransport}>{children}</BridgeContext.Provider>;
};

export function useBridge(): WebviewTransport {
    const context = useContext(BridgeContext);
    if (!context) {
        return getWebviewTransport();
    }
    return context;
}

export function useMessageListener<T = unknown>(handler: (message: T) => void): void {
    const bridge = useBridge();
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        const unsubscribe = bridge.onMessage((msg) => {
            handlerRef.current(msg as T);
        });
        return () => {
            unsubscribe();
        };
    }, [bridge]);
}

export function useRpcSender<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'>(
    schema?: z.ZodType<TMessage>,
    options?: WebviewRpcSenderOptions<K>,
): RpcSenderMethods<TMessage, K, Promise<unknown>> {
    const bridge = useBridge();
    const discriminatorKey = options?.discriminatorKey;
    const dispatcher = options?.dispatcher;

    return useMemo(
        () =>
            createWebviewRpcSender<TMessage, K>(bridge, schema, {
                discriminatorKey,
                dispatcher,
            }),
        [bridge, schema, discriminatorKey, dispatcher],
    );
}

export const useRpcClient = useRpcSender;

export function useRpcReceiver<
    TMessage extends DiscriminatedMessage<K>,
    TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>,
    K extends string = 'type',
>(
    schema: z.ZodType<TMessage>,
    handlers: RpcReceiverHandlers<TMessage, K>,
    options?: WebviewRpcReceiverOptions<TOutbound, K>,
): void {
    const bridge = useBridge();
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;

    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        const forwardingHandlers: RpcReceiverHandlers<TMessage, K> = new Proxy({} as RpcReceiverHandlers<TMessage, K>, {
            get(_target, prop: string) {
                const currentHandler = (handlersRef.current as Record<string, unknown>)[prop];
                if (typeof currentHandler === 'function') {
                    return (msg: unknown) => (currentHandler as (m: unknown) => unknown)(msg);
                }
                return undefined;
            },
        });

        const receiver = createWebviewRpcReceiver<TMessage, TOutbound, K>(schema, forwardingHandlers, {
            ...optionsRef.current,
            onError: (err, raw) => optionsRef.current?.onError?.(err, raw),
            messenger: {
                postMessage: (m) => bridge.postMessage(m),
            },
        });

        const unsubscribe = bridge.onMessage(async (msg) => {
            await receiver.dispatch(msg);
        });

        return () => {
            unsubscribe();
            receiver.dispose();
        };
    }, [bridge, schema]);
}

export const useRpcDispatcher = useRpcReceiver;
