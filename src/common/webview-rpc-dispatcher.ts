/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

import { toError } from '../utils/error-utils';
import type { LoggerChannel } from '../utils/output-channel';

export type DiscriminatedMessage<K extends string = 'type'> = {
    [P in K]: string;
};

export type MessagePayload<T> = T extends { payload: infer P } ? P : undefined;

export type MessageHandlerMap<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'> = {
    [V in TMessage[K]]?: MessagePayload<Extract<TMessage, { [P in K]: V }>> extends undefined
        ? () => unknown | Promise<unknown>
        : (payload: MessagePayload<Extract<TMessage, { [P in K]: V }>>) => unknown | Promise<unknown>;
};

export interface WebviewRpcDispatcherOptions<K extends string = 'type'> {
    discriminatorKey?: K;
    logger?: LoggerChannel;
    messenger?: WebviewPostMessageLike;
    onError?: (error: unknown, rawMessage: unknown) => void;
}

export const loggerSchema = z.object({
    type: z.literal('logMessage'),
    payload: z.object({
        level: z.enum(['info', 'warn', 'error']),
        message: z.string(),
        details: z.string().optional(),
    }),
});

export const rpcResponseSchema = z.object({
    type: z.literal('__rpc_response__'),
    requestId: z.string(),
    result: z.unknown().optional(),
    error: z.string().optional(),
});

type PendingPromise = {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
};

export class WebviewRpcDispatcher<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'> {
    private readonly discriminatorKey: K;
    private readonly pendingRequests = new Map<string, PendingPromise>();

    constructor(
        private readonly schema: z.ZodType<TMessage>,
        private readonly handlers: MessageHandlerMap<TMessage, K>,
        private readonly options?: WebviewRpcDispatcherOptions<K>,
    ) {
        this.discriminatorKey = options?.discriminatorKey ?? ('type' as K);
    }

    public registerPendingRequest(requestId: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
        });
    }

    public dispose(): void {
        for (const pending of this.pendingRequests.values()) {
            pending.reject(new Error('WebviewRpcDispatcher disposed'));
        }
        this.pendingRequests.clear();
    }

    private handleRpcResponse(rawMessage: unknown): boolean {
        const responseParse = rpcResponseSchema.safeParse(rawMessage);
        if (!responseParse.success) {
            return false;
        }
        const { requestId, result, error } = responseParse.data;
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
            this.pendingRequests.delete(requestId);
            if (error !== undefined) {
                pending.reject(new Error(error));
            } else {
                pending.resolve(result);
            }
            return true;
        }
        return false;
    }

    private async handleLogMessage(rawMessage: unknown): Promise<boolean> {
        const logMsgParse = loggerSchema.safeParse(rawMessage);
        if (!logMsgParse.success) {
            return false;
        }

        const { level, message, details } = logMsgParse.data.payload;
        const logStr = details ? `${message}: ${details}` : message;
        if (level === 'info') {
            this.options?.logger?.info?.(logStr);
        } else if (level === 'warn') {
            this.options?.logger?.warn?.(logStr);
        } else {
            this.options?.logger?.error(logStr);
        }

        const customHandler = (this.handlers as Record<string, unknown>).logMessage;
        if (typeof customHandler === 'function') {
            await (customHandler as (msg: unknown) => Promise<void>)(rawMessage);
        }
        return true;
    }

    public async dispatch(rawMessage: unknown): Promise<boolean> {
        if (this.handleRpcResponse(rawMessage)) {
            return true;
        }

        if (await this.handleLogMessage(rawMessage)) {
            return true;
        }

        const parseResult = this.schema.safeParse(rawMessage);
        if (!parseResult.success) {
            const isUnknownDiscriminator = parseResult.error.issues.some((issue) => issue.code === 'invalid_union');
            if (isUnknownDiscriminator) {
                return false;
            }
            this.options?.logger?.error('Webview RPC validation failed', parseResult.error);
            this.options?.onError?.(parseResult.error, rawMessage);
            return false;
        }

        const message = parseResult.data;
        const typeValue = message[this.discriminatorKey] as TMessage[K];
        const handler = this.handlers[typeValue] as ((payload?: unknown) => unknown | Promise<unknown>) | undefined;
        const requestId = (rawMessage as Record<string, unknown>)?.requestId as string | undefined;

        if (typeof handler === 'function') {
            try {
                const payload = (message as { payload?: unknown }).payload;
                const result = await (payload !== undefined ? handler(payload) : handler());
                if (requestId && this.options?.messenger) {
                    this.options.messenger.postMessage({
                        type: '__rpc_response__',
                        requestId,
                        result,
                    });
                }
                return true;
            } catch (err) {
                const error = toError(err);
                this.options?.logger?.error(`Webview RPC handler error (${String(typeValue)})`, error);
                this.options?.onError?.(err, rawMessage);

                if (requestId && this.options?.messenger) {
                    this.options.messenger.postMessage({
                        type: '__rpc_response__',
                        requestId,
                        error: error.message,
                    });
                }
                return false;
            }
        }

        if (requestId && this.options?.messenger) {
            this.options.messenger.postMessage({
                type: '__rpc_response__',
                requestId,
                error: `No handler registered for '${String(typeValue)}'`,
            });
        }
        return false;
    }
}

export function createWebviewRpcDispatcher<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'>(
    schema: z.ZodType<TMessage>,
    handlers: MessageHandlerMap<TMessage, K>,
    options?: WebviewRpcDispatcherOptions<K>,
): WebviewRpcDispatcher<TMessage, K> {
    return new WebviewRpcDispatcher<TMessage, K>(schema, handlers, options);
}

export type RpcClientMethods<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'> = {
    [V in TMessage[K]]: MessagePayload<Extract<TMessage, { [P in K]: V }>> extends undefined
        ? () => Promise<unknown>
        : (payload: MessagePayload<Extract<TMessage, { [P in K]: V }>>) => Promise<unknown>;
};

export interface WebviewPostMessageLike {
    postMessage(message: unknown): unknown;
}

export interface WebviewRpcPendingRequestRegisterable {
    registerPendingRequest(requestId: string): Promise<unknown>;
}

export interface WebviewRpcClientOptions<
    K extends string = 'type',
    TResponseMsg extends DiscriminatedMessage<K> = DiscriminatedMessage<K>,
> {
    discriminatorKey?: K;
    dispatcher?: WebviewRpcDispatcher<TResponseMsg, K> | WebviewRpcPendingRequestRegisterable;
}

export function createWebviewRpcClient<
    TMessage extends DiscriminatedMessage<K>,
    K extends string = 'type',
    TResponseMsg extends DiscriminatedMessage<K> = DiscriminatedMessage<K>,
>(
    webview: WebviewPostMessageLike,
    schema?: z.ZodType<TMessage>,
    options?: WebviewRpcClientOptions<K, TResponseMsg>,
): RpcClientMethods<TMessage, K> {
    let requestIdCounter = 0;
    const discriminatorKey = options?.discriminatorKey ?? ('type' as K);

    return new Proxy({} as RpcClientMethods<TMessage, K>, {
        get(_target, prop: string) {
            return (payload?: unknown) => {
                const requestId = `req_${Date.now()}_${++requestIdCounter}`;
                const message =
                    payload !== undefined
                        ? {
                              [discriminatorKey]: prop,
                              requestId,
                              payload,
                          }
                        : {
                              [discriminatorKey]: prop,
                              requestId,
                          };

                if (schema) {
                    const parseResult = schema.safeParse(message);
                    if (!parseResult.success) {
                        throw new Error(`Invalid RPC message '${prop}': ${parseResult.error.message}`);
                    }
                }

                let pendingPromise: Promise<unknown> | undefined;
                if (options?.dispatcher) {
                    pendingPromise = options.dispatcher.registerPendingRequest(requestId);
                }

                const sendResult = webview.postMessage(message);
                if (pendingPromise) {
                    return pendingPromise;
                }
                return Promise.resolve(sendResult);
            };
        },
    });
}
