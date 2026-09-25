/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { InputBoxOptions, QuickInputSession, QuickPickItem, QuickPickOptions } from './quick-input-types';

export interface CommandPaletteEntry {
    id: string;
    title: string;
    category?: string;
    iconClass?: string;
}

export class QuickInputService {
    private currentSession: QuickInputSession | null = null;
    private readonly listeners: Set<(session: QuickInputSession | null) => void> = new Set();

    public get activeSession(): QuickInputSession | null {
        return this.currentSession;
    }

    public onDidChangeSession(listener: (session: QuickInputSession | null) => void): { dispose: () => void } {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    private notifyListeners(): void {
        for (const listener of this.listeners) {
            listener(this.currentSession);
        }
    }

    public async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
        this.cancel();

        return new Promise<string | undefined>((resolve) => {
            this.currentSession = {
                type: 'input-box',
                options: options || {},
                resolve,
            };
            this.notifyListeners();
        });
    }

    public async showQuickPick<
        T extends { label: string; value?: unknown; description?: string; detail?: string; iconClass?: string },
    >(
        items: T[],
        options?: {
            title?: string;
            placeHolder?: string;
            matchOnDescription?: boolean;
            matchOnDetail?: boolean;
            acceptCustomValue?: boolean;
        },
    ): Promise<T | undefined> {
        this.cancel();

        const pickItems: QuickPickItem[] = items.map((item, index) => ({
            id: String(item.value ?? item.label ?? index),
            label: item.label,
            description: item.description,
            detail: item.detail,
            iconClass: item.iconClass,
            value: item,
        }));

        return new Promise<T | undefined>((resolve) => {
            const pickOptions: QuickPickOptions = {
                title: options?.title,
                placeHolder: options?.placeHolder,
                items: pickItems,
                matchOnDescription: options?.matchOnDescription,
                matchOnDetail: options?.matchOnDetail,
                acceptCustomValue: options?.acceptCustomValue,
            };

            this.currentSession = {
                type: 'quick-pick',
                options: pickOptions,
                resolve: (selected) => {
                    if (!selected) {
                        resolve(undefined);
                        return;
                    }
                    if (selected.value !== undefined) {
                        resolve(selected.value as T);
                        return;
                    }
                    const matched = items.find((it) => it.label === selected.label);
                    resolve(matched);
                },
            };
            this.notifyListeners();
        });
    }

    public async showMultiQuickPick<
        T extends { label: string; value?: unknown; description?: string; detail?: string; iconClass?: string },
    >(items: T[], options?: { title?: string; placeHolder?: string }): Promise<T[] | undefined> {
        this.cancel();

        const pickItems: QuickPickItem<T>[] = items.map((item, index) => ({
            id: String(item.value ?? item.label ?? index),
            label: item.label,
            description: item.description,
            detail: item.detail,
            iconClass: item.iconClass,
            value: item,
        }));

        return new Promise<T[] | undefined>((resolve) => {
            const pickOptions: QuickPickOptions = {
                title: options?.title,
                placeHolder: options?.placeHolder,
                items: pickItems,
                canSelectMany: true,
            };

            this.currentSession = {
                type: 'multi-quick-pick',
                options: pickOptions,
                resolve: (selectedList) => {
                    if (!selectedList) {
                        resolve(undefined);
                        return;
                    }
                    const mapped: T[] = [];
                    for (const item of selectedList) {
                        if (item.value !== undefined) {
                            mapped.push(item.value as T);
                        } else {
                            const matched = items.find((it) => it.label === item.label);
                            if (matched) {
                                mapped.push(matched);
                            }
                        }
                    }
                    resolve(mapped);
                },
            };
            this.notifyListeners();
        });
    }

    public async openCommandPalette(
        commands: CommandPaletteEntry[],
        onExecute: (commandId: string) => Promise<unknown> | unknown,
    ): Promise<void> {
        const getDisplayLabel = (cmd: CommandPaletteEntry): string => {
            const cleanTitle = cmd.title.replace(/^jj\s*view:\s*/i, '');
            const isJjViewCategory =
                !cmd.category ||
                cmd.category.trim().toLowerCase() === 'jj view' ||
                cmd.category.trim().toLowerCase() === 'jj-view';
            return isJjViewCategory ? cleanTitle : `${cmd.category}: ${cleanTitle}`;
        };

        const sorted = [...commands].sort((a, b) => {
            return getDisplayLabel(a).localeCompare(getDisplayLabel(b));
        });

        const items: QuickPickItem<string>[] = sorted.map((cmd) => {
            return {
                id: cmd.id,
                label: getDisplayLabel(cmd),
                iconClass: cmd.iconClass,
                value: cmd.id,
            };
        });

        const selected = await this.showQuickPick(items, {
            title: 'Command Palette',
            placeHolder: 'Type the name of a command to run...',
        });

        if (!selected) {
            return;
        }

        try {
            await onExecute(selected.id);
        } catch (err) {
            console.error('[CommandPalette] Execution failed for command:', selected.id, err);
        }
    }

    public accept(value: unknown): void {
        const session = this.currentSession;
        if (!session) {
            return;
        }
        this.currentSession = null;
        this.notifyListeners();

        if (session.type === 'input-box') {
            session.resolve(typeof value === 'string' ? value : undefined);
            return;
        }

        if (session.type === 'quick-pick') {
            session.resolve(value && typeof value === 'object' ? (value as QuickPickItem) : undefined);
            return;
        }

        if (session.type === 'multi-quick-pick') {
            session.resolve(Array.isArray(value) ? (value as QuickPickItem[]) : undefined);
            return;
        }
    }

    public cancel(): void {
        const session = this.currentSession;
        if (!session) {
            return;
        }
        this.currentSession = null;
        this.notifyListeners();

        if (session.type === 'input-box') {
            session.resolve(undefined);
            return;
        }
        if (session.type === 'quick-pick') {
            session.resolve(undefined);
            return;
        }
        if (session.type === 'multi-quick-pick') {
            session.resolve(undefined);
            return;
        }
    }
}
