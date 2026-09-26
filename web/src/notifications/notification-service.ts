/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NotificationItem, NotificationPosition, NotificationSeverity } from './notification-types';

export interface NotificationServiceOptions {
    position?: NotificationPosition;
    defaultInfoTimeoutMs?: number;
    defaultWarningTimeoutMs?: number;
}

export class NotificationService {
    private _items: NotificationItem[] = [];
    private _position: NotificationPosition;
    private readonly defaultInfoTimeoutMs: number;
    private readonly defaultWarningTimeoutMs: number;
    private readonly notificationListeners = new Set<(items: readonly NotificationItem[]) => void>();
    private readonly positionListeners = new Set<(pos: NotificationPosition) => void>();
    private idCounter = 0;

    constructor(options?: NotificationServiceOptions) {
        this._position = options?.position ?? 'bottom-right';
        this.defaultInfoTimeoutMs = options?.defaultInfoTimeoutMs ?? 5000;
        this.defaultWarningTimeoutMs = options?.defaultWarningTimeoutMs ?? 8000;
    }

    public get items(): readonly NotificationItem[] {
        return this._items;
    }

    public get position(): NotificationPosition {
        return this._position;
    }

    public setPosition(pos: NotificationPosition): void {
        if (this._position === pos) {
            return;
        }
        this._position = pos;
        for (const listener of this.positionListeners) {
            listener(pos);
        }
    }

    public onDidChangePosition(listener: (pos: NotificationPosition) => void): { dispose: () => void } {
        this.positionListeners.add(listener);
        return {
            dispose: () => {
                this.positionListeners.delete(listener);
            },
        };
    }

    public onDidChangeNotifications(listener: (items: readonly NotificationItem[]) => void): { dispose: () => void } {
        this.notificationListeners.add(listener);
        return {
            dispose: () => {
                this.notificationListeners.delete(listener);
            },
        };
    }

    private notifyListeners(): void {
        const copy = [...this._items];
        for (const listener of this.notificationListeners) {
            listener(copy);
        }
    }

    public async showInformation(message: string, ...actions: string[]): Promise<string | undefined> {
        const timeoutMs = actions.length === 0 ? this.defaultInfoTimeoutMs : undefined;
        return this.createNotification('info', message, actions, timeoutMs);
    }

    public async showWarning(message: string, ...actions: string[]): Promise<string | undefined> {
        const timeoutMs = actions.length === 0 ? this.defaultWarningTimeoutMs : undefined;
        return this.createNotification('warning', message, actions, timeoutMs);
    }

    public async showModalWarning(message: string, ...actions: string[]): Promise<string | undefined> {
        return this.createNotification('warning', message, actions, undefined);
    }

    public async showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined> {
        return this.createNotification('error', message, actions, undefined);
    }

    private createNotification(
        severity: NotificationSeverity,
        message: string,
        actions: string[],
        timeoutMs?: number,
    ): Promise<string | undefined> {
        const id = `notification-${++this.idCounter}-${Date.now()}`;

        return new Promise<string | undefined>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = () => {
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                const idx = this._items.findIndex((it) => it.id === id);
                if (idx !== -1) {
                    this._items.splice(idx, 1);
                    this.notifyListeners();
                }
            };

            const item: NotificationItem = {
                id,
                severity,
                message,
                actions,
                timestamp: Date.now(),
                timeoutMs,
                resolve: (action?: string) => {
                    cleanup();
                    resolve(action);
                },
                dismiss: () => {
                    cleanup();
                    resolve(undefined);
                },
            };

            if (timeoutMs !== undefined && timeoutMs > 0) {
                timer = setTimeout(() => {
                    item.dismiss();
                }, timeoutMs);
            }

            this._items.push(item);
            this.notifyListeners();
        });
    }

    public dismiss(id: string): void {
        const item = this._items.find((it) => it.id === id);
        if (!item) {
            return;
        }
        item.dismiss();
    }

    public triggerAction(id: string, action: string): void {
        const item = this._items.find((it) => it.id === id);
        if (!item) {
            return;
        }
        item.resolve(action);
    }

    public clearAll(): void {
        const items = [...this._items];
        for (const it of items) {
            it.dismiss();
        }
    }
}
