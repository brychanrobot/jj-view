/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

import { toError } from '../../utils/error-utils';
import type { LoggerChannel } from '../../utils/output-channel';

export type DiscriminatedMessage<K extends string = 'type'> = {
    [P in K]: string;
};

export type MessagePayload<T> = T extends { payload: infer P } ? P : undefined;

export type RpcReceiverHandlers<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'> = {
    [V in TMessage[K]]?: MessagePayload<Extract<TMessage, { [P in K]: V }>> extends undefined
        ? () => unknown | Promise<unknown>
        : (payload: MessagePayload<Extract<TMessage, { [P in K]: V }>>) => unknown | Promise<unknown>;
};

export type MessageHandlerMap<
    TMessage extends DiscriminatedMessage<K>,
    K extends string = 'type',
> = RpcReceiverHandlers<TMessage, K>;

export type InitialStateMap<TOutbound extends DiscriminatedMessage<'type'>> = string extends TOutbound['type']
    ? Record<string, unknown>
    : {
          [V in TOutbound['type']]?: MessagePayload<Extract<TOutbound, { type: V }>>;
      };

export type StateValue<TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>> =
    | TOutbound
    | InitialStateMap<TOutbound>
    | MessagePayload<Extract<TOutbound, { type: 'update' }>>
    | Record<string, unknown>
    | undefined;

export type StateProvider<TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>> = () =>
    | StateValue<TOutbound>
    | StateValue<TOutbound>[];

export type InitialStateValue<TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>> =
    StateValue<TOutbound>;

export type InitialStateProvider<TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>> =
    StateProvider<TOutbound>;

export interface WebviewRpcReceiverOptions<
    TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>,
    K extends string = 'type',
> {
    discriminatorKey?: K;
    logger?: LoggerChannel;
    messenger?: WebviewPostMessageLike;
    onError?: (error: unknown, rawMessage: unknown) => void;
    getState?: StateProvider<TOutbound>;
    state?: StateProvider<TOutbound>;
    getInitialState?: StateProvider<TOutbound>;
    maxQueueSize?: number;
}

export type WebviewRpcDispatcherOptions<
    TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>,
    K extends string = 'type',
> = WebviewRpcReceiverOptions<TOutbound, K>;

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

export class WebviewRpcReceiver<
    TMessage extends DiscriminatedMessage<K>,
    TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>,
    K extends string = 'type',
> {
    private readonly discriminatorKey: K;
    private readonly pendingRequests = new Map<string, PendingPromise>();
    private readonly _messengers = new Set<WebviewPostMessageLike>();
    private readonly _outboundQueue: unknown[] = [];
    private readonly _maxQueueSize: number;
    private _disposed = false;

    constructor(
        private readonly schema: z.ZodType<TMessage>,
        private readonly handlers: RpcReceiverHandlers<TMessage, K>,
        private readonly options?: WebviewRpcReceiverOptions<TOutbound, K>,
    ) {
        this.discriminatorKey = options?.discriminatorKey ?? ('type' as K);
        this._maxQueueSize = options?.maxQueueSize ?? 100;
        if (options?.messenger) {
            this.addMessenger(options.messenger);
        }
    }

    public get isDisposed(): boolean {
        return this._disposed;
    }

    public get hasMessengers(): boolean {
        return this._messengers.size > 0;
    }

    private _sender?: RpcSenderMethods<TOutbound, 'type', void>;

    public get sender(): RpcSenderMethods<TOutbound, 'type', void> {
        if (!this._sender) {
            this._sender = new Proxy({} as RpcSenderMethods<TOutbound, 'type', void>, {
                get: (_target, prop: string | symbol) => {
                    if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'constructor') {
                        return undefined;
                    }
                    return (payload?: unknown) => {
                        const message = payload !== undefined ? { type: prop, payload } : { type: prop };
                        this.broadcast(message as TOutbound);
                    };
                },
            });
        }
        return this._sender;
    }

    public get emitter(): RpcSenderMethods<TOutbound, 'type', void> {
        return this.sender;
    }

    public addMessenger(messenger: WebviewPostMessageLike): { dispose: () => void } {
        if (this._disposed) {
            return { dispose: () => {} };
        }

        this._messengers.add(messenger);
        this._flushOutboundQueue(messenger);
        this._sendState(messenger);

        let disposed = false;
        return {
            dispose: () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                this.removeMessenger(messenger);
            },
        };
    }

    public setMessenger(messenger: WebviewPostMessageLike | undefined): void {
        this._messengers.clear();
        if (!messenger || this._disposed) {
            return;
        }
        this.addMessenger(messenger);
    }

    public removeMessenger(messenger: WebviewPostMessageLike): void {
        this._messengers.delete(messenger);
    }

    public broadcast(message: unknown): void {
        if (this._disposed) {
            return;
        }

        if (this._messengers.size === 0) {
            if (this._maxQueueSize <= 0) {
                return;
            }
            if (this._outboundQueue.length >= this._maxQueueSize) {
                this._outboundQueue.shift();
            }
            this._outboundQueue.push(message);
            return;
        }

        this._postToMessengers(message, Array.from(this._messengers));
    }

    private _postToMessengers(message: unknown, recipients: readonly WebviewPostMessageLike[]): void {
        for (const messenger of recipients) {
            try {
                messenger.postMessage(message);
            } catch (err) {
                this.options?.logger?.error('WebviewRpcDispatcher post error', toError(err));
            }
        }
    }

    private _flushOutboundQueue(targetMessenger?: WebviewPostMessageLike): void {
        if (this._outboundQueue.length === 0) {
            return;
        }

        const recipients = targetMessenger ? [targetMessenger] : Array.from(this._messengers);
        if (recipients.length === 0) {
            return;
        }

        const pending = this._outboundQueue.splice(0, this._outboundQueue.length);
        for (const message of pending) {
            this._postToMessengers(message, recipients);
        }
    }

    private _sendState(targetMessenger?: WebviewPostMessageLike): void {
        const stateProvider = this.options?.getState ?? this.options?.state ?? this.options?.getInitialState;
        if (!stateProvider) {
            return;
        }

        let stateResult: unknown | undefined;
        try {
            stateResult = stateProvider();
        } catch (err) {
            this.options?.logger?.error('WebviewRpcDispatcher state provider error', toError(err));
            return;
        }

        if (stateResult === undefined || stateResult === null) {
            return;
        }

        const recipients = targetMessenger ? [targetMessenger] : Array.from(this._messengers);
        if (recipients.length === 0) {
            return;
        }

        const items = Array.isArray(stateResult) ? stateResult : [stateResult];
        for (const item of items) {
            if (item === undefined || item === null) {
                continue;
            }

            if (typeof item === 'object' && 'type' in item) {
                this._postToMessengers(item, recipients);
                continue;
            }

            if (typeof item === 'object') {
                const definedKeys = Object.keys(item).filter((k) => (item as Record<string, unknown>)[k] !== undefined);
                if (definedKeys.length === 1 && definedKeys[0] === 'update') {
                    this._postToMessengers(
                        {
                            type: 'update',
                            payload: (item as Record<string, unknown>).update,
                        },
                        recipients,
                    );
                    continue;
                }

                this._postToMessengers(
                    {
                        type: 'update',
                        payload: item,
                    },
                    recipients,
                );
            }
        }
    }

    public registerPendingRequest(requestId: string): Promise<unknown> {
        if (this._disposed) {
            return Promise.reject(new Error('WebviewRpcDispatcher is disposed'));
        }
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
        });
    }

    public unregisterPendingRequest(requestId: string): void {
        this.pendingRequests.delete(requestId);
    }

    public dispose(): void {
        this._disposed = true;
        for (const pending of this.pendingRequests.values()) {
            pending.reject(new Error('WebviewRpcDispatcher disposed'));
        }
        this.pendingRequests.clear();
        this._messengers.clear();
        this._outboundQueue.length = 0;
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
        }
        return true;
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
            try {
                await (customHandler as (msg: unknown) => Promise<void>)(logMsgParse.data.payload);
            } catch (err) {
                this.options?.logger?.error('WebviewRpcDispatcher logMessage handler error', toError(err));
            }
        }
        return true;
    }

    public async dispatch(rawMessage: unknown): Promise<boolean> {
        if (this._disposed) {
            return false;
        }

        if (this.handleRpcResponse(rawMessage)) {
            return true;
        }

        if (await this.handleLogMessage(rawMessage)) {
            return true;
        }

        const rawTypeValue = (rawMessage as Record<string, unknown>)?.[this.discriminatorKey];
        if (rawTypeValue === 'webviewLoaded') {
            this._flushOutboundQueue();
            this._sendState();
            const customLoadedHandler = this.handlers['webviewLoaded' as TMessage[K]] as (() => unknown) | undefined;
            if (typeof customLoadedHandler === 'function') {
                try {
                    await customLoadedHandler();
                } catch (err) {
                    this.options?.logger?.error('WebviewRpcDispatcher webviewLoaded handler error', toError(err));
                }
            }
            const requestId = (rawMessage as Record<string, unknown>)?.requestId as string | undefined;
            if (requestId) {
                this._sendRpcSuccessResponse(requestId, undefined);
            }
            return true;
        }

        const parseResult = this.schema.safeParse(rawMessage);
        const requestId = (rawMessage as Record<string, unknown>)?.requestId as string | undefined;

        if (!parseResult.success) {
            const isUnknownDiscriminator = parseResult.error.issues.some(
                (issue) =>
                    issue.code === 'invalid_union' ||
                    (issue as { code: string }).code === 'invalid_union_discriminator',
            );
            if (isUnknownDiscriminator) {
                return false;
            }

            this.options?.logger?.error('Webview RPC validation failed', parseResult.error);
            try {
                this.options?.onError?.(parseResult.error, rawMessage);
            } catch (e) {
                this.options?.logger?.error('WebviewRpcDispatcher onError callback failed', toError(e));
            }
            this._sendRpcErrorResponse(requestId, `Validation failed: ${parseResult.error.message}`);
            return false;
        }

        const message = parseResult.data;
        const typeValue = message[this.discriminatorKey] as TMessage[K];
        const handler = this.handlers[typeValue] as ((payload?: unknown) => unknown | Promise<unknown>) | undefined;

        if (typeof handler !== 'function') {
            this._sendRpcErrorResponse(requestId, `No handler registered for '${String(typeValue)}'`);
            return false;
        }

        try {
            const payload = (message as { payload?: unknown }).payload;
            const result = await (payload !== undefined ? handler(payload) : handler());
            this._sendRpcSuccessResponse(requestId, result);
            return true;
        } catch (err) {
            const error = toError(err);
            this.options?.logger?.error(`Webview RPC handler error (${String(typeValue)})`, error);
            try {
                this.options?.onError?.(err, rawMessage);
            } catch (e) {
                this.options?.logger?.error('WebviewRpcDispatcher onError callback failed', toError(e));
            }
            this._sendRpcErrorResponse(requestId, error.message);
            return false;
        }
    }

    private _sendRpcSuccessResponse(requestId: string | undefined, result: unknown): void {
        if (!requestId) {
            return;
        }
        this.broadcast({
            type: '__rpc_response__',
            requestId,
            result,
        });
    }

    private _sendRpcErrorResponse(requestId: string | undefined, error: string): void {
        if (!requestId) {
            return;
        }
        this.broadcast({
            type: '__rpc_response__',
            requestId,
            error,
        });
    }
}

export const WebviewRpcDispatcher = WebviewRpcReceiver;
export type WebviewRpcDispatcher<
    TMessage extends DiscriminatedMessage<K>,
    TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>,
    K extends string = 'type',
> = WebviewRpcReceiver<TMessage, TOutbound, K>;

export function createWebviewRpcReceiver<
    TMessage extends DiscriminatedMessage<K>,
    TOutbound extends DiscriminatedMessage<'type'> = DiscriminatedMessage<'type'>,
    K extends string = 'type',
>(
    schema: z.ZodType<TMessage>,
    handlers: RpcReceiverHandlers<TMessage, K>,
    options?: WebviewRpcReceiverOptions<TOutbound, K>,
): WebviewRpcReceiver<TMessage, TOutbound, K> {
    return new WebviewRpcReceiver<TMessage, TOutbound, K>(schema, handlers, options);
}

export const createWebviewRpcDispatcher = createWebviewRpcReceiver;

export type ReservedRpcProperties = 'then' | 'toJSON' | 'constructor';

export type RpcSenderMethods<
    TMessage extends DiscriminatedMessage<K>,
    K extends string = 'type',
    TReturn = Promise<unknown>,
> = {
    [V in Exclude<TMessage[K], ReservedRpcProperties>]: MessagePayload<
        Extract<TMessage, { [P in K]: V }>
    > extends undefined
        ? () => TReturn
        : (payload: MessagePayload<Extract<TMessage, { [P in K]: V }>>) => TReturn;
};

export type RpcClientMethods<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'> = RpcSenderMethods<
    TMessage,
    K,
    Promise<unknown>
>;

export type RpcEmitterMethods<TOutbound extends DiscriminatedMessage<'type'>> = RpcSenderMethods<
    TOutbound,
    'type',
    void
>;

export interface WebviewPostMessageLike {
    postMessage(message: unknown): unknown;
}

export interface WebviewRpcPendingRequestRegisterable {
    registerPendingRequest(requestId: string): Promise<unknown>;
    unregisterPendingRequest?(requestId: string): void;
}

export interface WebviewRpcSenderOptions<K extends string = 'type'> {
    discriminatorKey?: K;
    dispatcher?: WebviewRpcPendingRequestRegisterable;
    receiver?: WebviewRpcPendingRequestRegisterable;
}

export type WebviewRpcClientOptions<K extends string = 'type'> = WebviewRpcSenderOptions<K>;

let globalRequestIdCounter = 0;

export function createWebviewRpcSender<TMessage extends DiscriminatedMessage<K>, K extends string = 'type'>(
    webview: WebviewPostMessageLike,
    schema?: z.ZodType<TMessage>,
    options?: WebviewRpcSenderOptions<K>,
): RpcSenderMethods<TMessage, K, Promise<unknown>> {
    const discriminatorKey = options?.discriminatorKey ?? ('type' as K);
    const requestRegisterable = options?.receiver ?? options?.dispatcher;

    return new Proxy({} as RpcSenderMethods<TMessage, K, Promise<unknown>>, {
        get(_target, prop: string | symbol) {
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'constructor') {
                return undefined;
            }

            return (payload?: unknown) => {
                const randomToken = Math.random().toString(36).slice(2, 8);
                const requestId = `req_${Date.now()}_${++globalRequestIdCounter}_${randomToken}`;
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
                if (requestRegisterable) {
                    pendingPromise = requestRegisterable.registerPendingRequest(requestId);
                }

                try {
                    const sendResult = webview.postMessage(message);
                    if (pendingPromise) {
                        return pendingPromise;
                    }
                    return Promise.resolve(sendResult);
                } catch (err) {
                    if (requestRegisterable?.unregisterPendingRequest) {
                        requestRegisterable.unregisterPendingRequest(requestId);
                    }
                    throw err;
                }
            };
        },
    });
}

export const createWebviewRpcClient = createWebviewRpcSender;
