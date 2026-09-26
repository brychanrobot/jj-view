/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface StatusMessage {
    id: number;
    text: string;
    timeoutMs?: number;
}

export interface ProgressState {
    active: boolean;
    title?: string;
    activeTasks: number;
}

export interface WorkingCopyState {
    changeId?: string;
    bookmark?: string;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

export interface StatusBarState {
    statusMessage?: StatusMessage;
    progress: ProgressState;
    workingCopy?: WorkingCopyState;
    connection: ConnectionStatus;
}

export class StatusBarService {
    private currentMessage?: StatusMessage;
    private messageTimer?: ReturnType<typeof setTimeout>;
    private nextMessageId = 0;

    private activeProgressTasks = 0;
    private latestProgressTitle?: string;

    private currentWorkingCopy?: WorkingCopyState;
    private connectionStatus: ConnectionStatus = 'connected';

    private readonly listeners = new Set<(state: StatusBarState) => void>();

    public get state(): StatusBarState {
        return {
            statusMessage: this.currentMessage,
            progress: {
                active: this.activeProgressTasks > 0,
                title: this.latestProgressTitle,
                activeTasks: this.activeProgressTasks,
            },
            workingCopy: this.currentWorkingCopy,
            connection: this.connectionStatus,
        };
    }

    public onDidChangeStatus(listener: (state: StatusBarState) => void): { dispose: () => void } {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    private notifyListeners(): void {
        const snapshot = this.state;
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    public setMessage(text: string, timeoutMs?: number): { dispose: () => void } {
        if (this.messageTimer !== undefined) {
            clearTimeout(this.messageTimer);
            this.messageTimer = undefined;
        }

        const id = ++this.nextMessageId;
        this.currentMessage = {
            id,
            text,
            timeoutMs,
        };
        this.notifyListeners();

        if (timeoutMs !== undefined && timeoutMs > 0) {
            this.messageTimer = setTimeout(() => {
                if (this.currentMessage?.id === id) {
                    this.currentMessage = undefined;
                    this.messageTimer = undefined;
                    this.notifyListeners();
                }
            }, timeoutMs);
        }

        return {
            dispose: () => {
                if (this.currentMessage?.id === id) {
                    if (this.messageTimer !== undefined) {
                        clearTimeout(this.messageTimer);
                        this.messageTimer = undefined;
                    }
                    this.currentMessage = undefined;
                    this.notifyListeners();
                }
            },
        };
    }

    public clearMessage(): void {
        if (this.messageTimer !== undefined) {
            clearTimeout(this.messageTimer);
            this.messageTimer = undefined;
        }
        if (this.currentMessage !== undefined) {
            this.currentMessage = undefined;
            this.notifyListeners();
        }
    }

    public async withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
        this.activeProgressTasks++;
        this.latestProgressTitle = title;
        this.notifyListeners();

        try {
            return await task();
        } finally {
            this.activeProgressTasks--;
            if (this.activeProgressTasks === 0) {
                this.latestProgressTitle = undefined;
            }
            this.notifyListeners();
        }
    }

    public setWorkingCopy(info: WorkingCopyState | undefined): void {
        this.currentWorkingCopy = info;
        this.notifyListeners();
    }

    public setConnectionStatus(status: ConnectionStatus): void {
        if (this.connectionStatus === status) {
            return;
        }
        this.connectionStatus = status;
        this.notifyListeners();
    }
}
