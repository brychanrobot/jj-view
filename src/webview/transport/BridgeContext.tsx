/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as React from 'react';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { z } from 'zod';
import {
    createWebviewRpcClient,
    createWebviewRpcDispatcher,
    type DiscriminatedMessage,
    type MessageHandlerMap,
    type RpcClientMethods,
    type WebviewRpcClientOptions,
    type WebviewRpcDispatcherOptions,
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

export function useRpcClient<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'>(
    schema?: z.ZodType<TMessage>,
    options?: WebviewRpcClientOptions<K>,
): RpcClientMethods<TMessage, K> {
    const bridge = useBridge();
    const discriminatorKey = options?.discriminatorKey;
    const dispatcher = options?.dispatcher;

    return useMemo(
        () =>
            createWebviewRpcClient<TMessage, K>(bridge, schema, {
                discriminatorKey,
                dispatcher,
            }),
        [bridge, schema, discriminatorKey, dispatcher],
    );
}

export function useRpcDispatcher<
    TMessage extends DiscriminatedMessage<K>,
    TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>,
    K extends string = 'type',
>(
    schema: z.ZodType<TMessage>,
    handlers: MessageHandlerMap<TMessage, K>,
    options?: WebviewRpcDispatcherOptions<TOutbound, K>,
): void {
    const bridge = useBridge();
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;

    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        const forwardingHandlers: MessageHandlerMap<TMessage, K> = new Proxy({} as MessageHandlerMap<TMessage, K>, {
            get(_target, prop: string) {
                const currentHandler = (handlersRef.current as Record<string, unknown>)[prop];
                if (typeof currentHandler === 'function') {
                    return (msg: unknown) => (currentHandler as (m: unknown) => unknown)(msg);
                }
                return undefined;
            },
        });

        const dispatcher = createWebviewRpcDispatcher<TMessage, TOutbound, K>(schema, forwardingHandlers, {
            ...optionsRef.current,
            onError: (err, raw) => optionsRef.current?.onError?.(err, raw),
            messenger: {
                postMessage: (m) => bridge.postMessage(m),
            },
        });

        const unsubscribe = bridge.onMessage(async (msg) => {
            await dispatcher.dispatch(msg);
        });

        return () => {
            unsubscribe();
            dispatcher.dispose();
        };
    }, [bridge, schema]);
}
