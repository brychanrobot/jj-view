/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type AsyncEvent, AsyncEventEmitter, type Disposable } from '../../core/host/events';
import type { ContextSource } from './when-evaluator';

export interface IContextKeyService extends ContextSource, Disposable {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    setMany(keys: Record<string, unknown>): void;
    delete(key: string): void;
    createScoped(initialKeys?: Record<string, unknown>): IContextKeyService;
    readonly onDidChangeContext: AsyncEvent<void>;
    toRecord(): Record<string, unknown>;
}

export class ContextKeyService implements IContextKeyService {
    private readonly _keys = new Map<string, unknown>();
    private readonly _parent?: ContextKeyService;
    private readonly _disposables: Disposable[] = [];
    private _isDisposed = false;

    private readonly _onDidChangeContext = new AsyncEventEmitter<void>();
    private _parentSubscription?: Disposable;

    public get onDidChangeContext(): AsyncEvent<void> {
        this._ensureParentSubscription();
        return this._onDidChangeContext.event;
    }

    constructor(parent?: ContextKeyService, initialKeys?: Record<string, unknown>) {
        this._parent = parent;
        if (initialKeys) {
            for (const [k, v] of Object.entries(initialKeys)) {
                this._keys.set(k, v);
            }
        }
    }

    private _ensureParentSubscription(): void {
        if (this._parent && !this._parentSubscription) {
            this._parentSubscription = this._parent.onDidChangeContext(() => {
                this._onDidChangeContext.fire();
            });
            this._disposables.push(this._parentSubscription);
        }
    }

    public get<T = unknown>(key: string): T | undefined {
        if (this._keys.has(key)) {
            return this._keys.get(key) as T;
        }
        if (this._parent) {
            return this._parent.get<T>(key);
        }
        return undefined;
    }

    public set(key: string, value: unknown): void {
        if (this._isDisposed) {
            return;
        }
        const prev = this._keys.get(key);
        if (prev === value) {
            return;
        }
        this._keys.set(key, value);
        this._onDidChangeContext.fire();
    }

    public setMany(keys: Record<string, unknown>): void {
        if (this._isDisposed) {
            return;
        }
        let changed = false;
        for (const [k, v] of Object.entries(keys)) {
            const prev = this._keys.get(k);
            if (prev !== v) {
                this._keys.set(k, v);
                changed = true;
            }
        }
        if (changed) {
            this._onDidChangeContext.fire();
        }
    }

    public delete(key: string): void {
        if (this._isDisposed) {
            return;
        }
        if (this._keys.delete(key)) {
            this._onDidChangeContext.fire();
        }
    }

    public createScoped(initialKeys?: Record<string, unknown>): IContextKeyService {
        return new ContextKeyService(this, initialKeys);
    }

    public toRecord(): Record<string, unknown> {
        const parentRecord = this._parent ? this._parent.toRecord() : {};
        const currentRecord: Record<string, unknown> = {};
        for (const [k, v] of this._keys.entries()) {
            currentRecord[k] = v;
        }
        return {
            ...parentRecord,
            ...currentRecord,
        };
    }

    public dispose(): void {
        if (this._isDisposed) {
            return;
        }
        this._isDisposed = true;
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._keys.clear();
        this._onDidChangeContext.dispose();
    }
}
