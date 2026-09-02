/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';
import type { z } from 'zod';
import {
    createWebviewRpcReceiver,
    createWebviewRpcSender,
    type DiscriminatedMessage,
    type RpcReceiverHandlers,
    type RpcSenderMethods,
    type WebviewRpcReceiver,
} from '../core/host/webview-rpc-dispatcher';
import { createMock } from './test-utils';

export interface MockWebviewClient<
    TToHost extends DiscriminatedMessage<KToHost>,
    THostToWebview extends DiscriminatedMessage<'type'>,
    KToHost extends string = 'type',
> {
    panel: vscode.WebviewPanel;
    view: vscode.WebviewView;
    webview: vscode.Webview;
    sender: RpcSenderMethods<TToHost, KToHost, Promise<unknown>>;
    receiver: WebviewRpcReceiver<THostToWebview, DiscriminatedMessage<'type'>, 'type'>;
    receivedMessages: THostToWebview[];
    triggerVisibilityChange: (visible: boolean) => void;
    dispose: () => void;
}

export interface MockWebviewClientOptions<
    TToHost extends DiscriminatedMessage<KToHost>,
    THostToWebview extends DiscriminatedMessage<'type'>,
    KToHost extends string = 'type',
> {
    toHostSchema: z.ZodType<TToHost>;
    hostToWebviewSchema: z.ZodType<THostToWebview>;
    handlers?: Partial<RpcReceiverHandlers<THostToWebview, 'type'>>;
    toHostDiscriminatorKey?: KToHost;
}

/**
 * Creates a type-safe mock webview client connected to a mock WebviewPanel, WebviewView, and Webview.
 * Automatically wires bi-directional RPC dispatching and validates messages against the provided schemas.
 */
export function createMockWebviewClient<
    TToHost extends DiscriminatedMessage<KToHost>,
    THostToWebview extends DiscriminatedMessage<'type'>,
    KToHost extends string = 'type',
>(
    options: MockWebviewClientOptions<TToHost, THostToWebview, KToHost>,
): MockWebviewClient<TToHost, THostToWebview, KToHost> {
    let hostMessageListener: ((msg: unknown) => Promise<void> | void) | undefined;
    let disposeListener: (() => void) | undefined;
    let visibilityListener: ((e: undefined) => void) | undefined;
    let isVisible = true;
    const receivedMessages: THostToWebview[] = [];

    const handlersProxy = new Proxy({} as RpcReceiverHandlers<THostToWebview, 'type'>, {
        get(_target, prop: string) {
            return async (payload: unknown) => {
                const message = payload !== undefined ? { type: prop, payload } : { type: prop };
                receivedMessages.push(message as THostToWebview);
                const customHandler = options.handlers?.[prop as keyof typeof options.handlers];
                if (typeof customHandler === 'function') {
                    return (customHandler as (p: unknown) => unknown)(payload);
                }
                return undefined;
            };
        },
    });

    const receiver = createWebviewRpcReceiver<THostToWebview, DiscriminatedMessage<'type'>, 'type'>(
        options.hostToWebviewSchema,
        handlersProxy,
    );

    const webview = createMock<vscode.Webview>({
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (listener: (msg: unknown) => Promise<void> | void) => {
            hostMessageListener = listener;
            return {
                dispose: () => {
                    hostMessageListener = undefined;
                },
            };
        },
        postMessage: async (msg: unknown) => {
            await receiver.dispatch(msg);
            return true;
        },
    });

    const panel = createMock<vscode.WebviewPanel>({
        webview,
        onDidDispose: (listener: () => void) => {
            disposeListener = listener;
            return {
                dispose: () => {
                    disposeListener = undefined;
                },
            };
        },
        dispose: () => {
            disposeListener?.();
        },
    });

    const view = createMock<vscode.WebviewView>({
        webview,
        get visible() {
            return isVisible;
        },
        onDidChangeVisibility: (listener: (e: undefined) => void) => {
            visibilityListener = listener;
            return {
                dispose: () => {
                    visibilityListener = undefined;
                },
            };
        },
        onDidDispose: (listener: () => void) => {
            disposeListener = listener;
            return {
                dispose: () => {
                    disposeListener = undefined;
                },
            };
        },
        show: () => {},
    });

    const clientBridge = {
        postMessage: (msg: unknown) => {
            if (hostMessageListener) {
                return hostMessageListener(msg);
            }
            return undefined;
        },
    };

    const sender = createWebviewRpcSender<TToHost, KToHost>(clientBridge, options.toHostSchema, {
        discriminatorKey: options.toHostDiscriminatorKey,
    });

    return {
        panel,
        view,
        webview,
        sender,
        receiver,
        receivedMessages,
        triggerVisibilityChange: (visible: boolean) => {
            isVisible = visible;
            visibilityListener?.(undefined);
        },
        dispose: () => {
            receiver.dispose();
            disposeListener?.();
        },
    };
}
