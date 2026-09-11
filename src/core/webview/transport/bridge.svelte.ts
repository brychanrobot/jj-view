/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getContext, setContext } from 'svelte';
import type { z } from 'zod';
import {
    createWebviewRpcReceiver,
    createWebviewRpcSender,
    type DiscriminatedMessage,
    type RpcReceiverHandlers,
    type RpcSenderMethods,
    type WebviewRpcReceiverOptions,
    type WebviewRpcSenderOptions,
} from '../../host/webview-rpc-dispatcher';
import { getWebviewTransport } from './registry';
import type { WebviewTransport } from './types';

const BRIDGE_KEY = Symbol('JJ_VIEW_BRIDGE');

export function initBridge(transport?: WebviewTransport): WebviewTransport {
    const active = transport ?? getWebviewTransport();
    setContext(BRIDGE_KEY, active);
    return active;
}

export function useBridge(): WebviewTransport {
    return getContext<WebviewTransport>(BRIDGE_KEY) ?? getWebviewTransport();
}

export function useMessageListener<T = unknown>(handler: (message: T) => void): void {
    const bridge = useBridge();
    $effect(() => {
        const unsubscribe = bridge.onMessage((msg) => {
            handler(msg as T);
        });
        return () => {
            unsubscribe();
        };
    });
}

export function useRpcSender<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'>(
    schema?: z.ZodType<TMessage>,
    options?: WebviewRpcSenderOptions<K>,
): RpcSenderMethods<TMessage, K, Promise<unknown>> {
    const bridge = useBridge();
    return createWebviewRpcSender<TMessage, K>(bridge, schema, options);
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

    $effect(() => {
        const receiver = createWebviewRpcReceiver<TMessage, TOutbound, K>(schema, handlers, {
            ...options,
            onError: (err, raw) => options?.onError?.(err, raw),
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
    });
}

export const useRpcDispatcher = useRpcReceiver;
