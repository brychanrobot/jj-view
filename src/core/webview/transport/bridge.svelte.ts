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

let moduleBridge: WebviewTransport | undefined;

function createSnapshotTransport(raw: WebviewTransport): WebviewTransport {
    return {
        postMessage: (message: unknown) => {
            raw.postMessage($state.snapshot(message));
        },
        onMessage: (handler) => raw.onMessage(handler),
        dispose: () => raw.dispose?.(),
    };
}

export function initBridge(transport?: WebviewTransport): WebviewTransport {
    const active = createSnapshotTransport(transport ?? getWebviewTransport());
    moduleBridge = active;
    try {
        setContext(BRIDGE_KEY, active);
    } catch {
        // Called outside component initialization (e.g. in webview index.ts)
    }
    return active;
}

export function useBridge(): WebviewTransport {
    try {
        const ctx = getContext<WebviewTransport>(BRIDGE_KEY);
        if (ctx) {
            return ctx;
        }
    } catch {
        // Called outside component initialization
    }
    return moduleBridge ?? createSnapshotTransport(getWebviewTransport());
}

export function useMessageListener<T = unknown>(handler: (message: T) => void): void {
    const bridge = useBridge();
    const unsubscribe = bridge.onMessage((msg) => {
        handler(msg as T);
    });
    $effect(() => {
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

    $effect(() => {
        return () => {
            unsubscribe();
            receiver.dispose();
        };
    });
}

export const useRpcDispatcher = useRpcReceiver;
