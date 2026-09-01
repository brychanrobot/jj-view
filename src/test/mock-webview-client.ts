/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
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
    TToHost extends DiscriminatedMessage<'type'>,
    THostToWebview extends DiscriminatedMessage<'type'>,
> {
    panel: vscode.WebviewPanel;
    view: vscode.WebviewView;
    webview: vscode.Webview;
    sender: RpcSenderMethods<TToHost, 'type', Promise<unknown>>;
    receiver: WebviewRpcReceiver<THostToWebview, TToHost, 'type'>;
    receivedMessages: THostToWebview[];
    triggerVisibilityChange: (visible: boolean) => void;
    dispose: () => void;
}

export interface MockWebviewClientOptions<
    TToHost extends DiscriminatedMessage<'type'>,
    THostToWebview extends DiscriminatedMessage<'type'>,
> {
    toHostSchema: z.ZodType<TToHost>;
    hostToWebviewSchema: z.ZodType<THostToWebview>;
    handlers?: Partial<RpcReceiverHandlers<THostToWebview, 'type'>>;
}

/**
 * Creates a type-safe mock webview client connected to a mock WebviewPanel, WebviewView, and Webview.
 * Automatically wires bi-directional RPC dispatching and validates messages against the provided schemas.
 */
export function createMockWebviewClient<
    TToHost extends DiscriminatedMessage<'type'>,
    THostToWebview extends DiscriminatedMessage<'type'>,
>(options: MockWebviewClientOptions<TToHost, THostToWebview>): MockWebviewClient<TToHost, THostToWebview> {
    let hostMessageListener: ((msg: unknown) => Promise<void> | void) | undefined;
    let disposeListener: (() => void) | undefined;
    let visibilityListener: ((e: undefined) => void) | undefined;
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

    const receiver = createWebviewRpcReceiver<THostToWebview, TToHost, 'type'>(
        options.hostToWebviewSchema,
        handlersProxy,
    );

    const webview = createMock<vscode.Webview>({
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: vi.fn((listener: (msg: unknown) => Promise<void> | void) => {
            hostMessageListener = listener;
            return {
                dispose: () => {
                    hostMessageListener = undefined;
                },
            };
        }),
        postMessage: vi.fn(async (msg: unknown) => {
            await receiver.dispatch(msg);
            return true;
        }),
    });

    const panel = createMock<vscode.WebviewPanel>({
        webview,
        onDidDispose: vi.fn((listener: () => void) => {
            disposeListener = listener;
            return {
                dispose: () => {
                    disposeListener = undefined;
                },
            };
        }),
        dispose: vi.fn(() => {
            disposeListener?.();
        }),
    });

    const view = createMock<vscode.WebviewView>({
        webview,
        visible: true,
        onDidChangeVisibility: vi.fn((listener: (e: undefined) => void) => {
            visibilityListener = listener;
            return {
                dispose: () => {
                    visibilityListener = undefined;
                },
            };
        }),
        onDidDispose: vi.fn((listener: () => void) => {
            disposeListener = listener;
            return {
                dispose: () => {
                    disposeListener = undefined;
                },
            };
        }),
        show: vi.fn(),
    });

    const clientBridge = {
        postMessage: (msg: unknown) => {
            if (hostMessageListener) {
                void hostMessageListener(msg);
            }
        },
    };

    const sender = createWebviewRpcSender<TToHost, 'type'>(clientBridge, options.toHostSchema);

    return {
        panel,
        view,
        webview,
        sender,
        receiver,
        receivedMessages,
        triggerVisibilityChange: (visible: boolean) => {
            (view as { visible: boolean }).visible = visible;
            visibilityListener?.(undefined);
        },
        dispose: () => {
            receiver.dispose();
            disposeListener?.();
        },
    };
}
