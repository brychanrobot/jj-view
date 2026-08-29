/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Disposable, type Event, EventEmitter } from '../common/events';
import type { HostEnvironment } from '../common/host-environment';
import {
    type ProcessMonitorHostToWebviewMessage,
    type ProcessMonitorToHostMessage,
    ProcessMonitorToHostMessageSchema,
} from '../common/ipc/process-monitor-schemas';
import {
    createWebviewRpcDispatcher,
    type WebviewPostMessageLike,
    type WebviewRpcDispatcher,
} from '../common/webview-rpc-dispatcher';
import {
    getTaskExitCode,
    type JjProcessMetrics,
    type JjProcessTask,
    type JjProcessTracker,
} from '../jj-process-tracker';
import { CoalescingQueue } from '../utils/coalescing-queue';
import type { LoggerChannel } from '../utils/output-channel';

export interface ProcessMonitorControllerOptions {
    messenger?: WebviewPostMessageLike;
    logger?: LoggerChannel;
}

export class ProcessMonitorController implements Disposable {
    private _disposed = false;
    private readonly _disposables: Disposable[] = [];
    private _messenger?: WebviewPostMessageLike;
    private readonly _logger?: LoggerChannel;
    private readonly _updateQueue: CoalescingQueue;
    private readonly _dispatcher: WebviewRpcDispatcher<ProcessMonitorToHostMessage, 'command'>;

    private readonly _onDidUpdate = new EventEmitter<void>();
    public readonly onDidUpdate: Event<void> = this._onDidUpdate.event;

    constructor(
        private readonly _processTracker: JjProcessTracker,
        private readonly _host: HostEnvironment,
        options?: ProcessMonitorControllerOptions,
    ) {
        this._messenger = options?.messenger;
        this._logger = options?.logger;

        this._updateQueue = new CoalescingQueue(async () => {
            this.updateWebview();
        });

        this._disposables.push(
            this._processTracker.onDidChangeProcesses(() => {
                if (!this._disposed) {
                    this._updateQueue.run();
                }
            }),
        );

        this._dispatcher = createWebviewRpcDispatcher(
            ProcessMonitorToHostMessageSchema,
            {
                killProcess: (payload) => {
                    this.cancelProcess(payload.id);
                },
                killAllProcesses: () => {
                    this.cancelAllProcesses();
                },
                clearHistory: () => {
                    this.clearHistory();
                },
                hidePanel: async () => {
                    await this._host.config.update?.('showProcessMonitorPanel', false);
                },
            },
            {
                discriminatorKey: 'command',
                logger: this._logger,
                messenger: {
                    postMessage: (m) => this._postMessage(m as ProcessMonitorHostToWebviewMessage),
                },
            },
        );

        this.updateWebview();
    }

    public get tracker(): JjProcessTracker {
        return this._processTracker;
    }

    public get activeTasks(): readonly JjProcessTask[] {
        return this._processTracker.getActiveTasks();
    }

    public get historyTasks(): readonly JjProcessTask[] {
        return this._processTracker.getHistory();
    }

    public setMessenger(messenger: WebviewPostMessageLike | undefined): void {
        this._messenger = messenger;
        if (messenger) {
            this.updateWebview();
        }
    }

    public async handleMessage(rawMessage: unknown): Promise<boolean> {
        if (this._disposed) {
            return false;
        }
        return this._dispatcher.dispatch(rawMessage);
    }

    public updateWebview(): void {
        if (this._disposed) {
            return;
        }

        const activeTasks = this._processTracker.getActiveTasks().map((t: JjProcessTask) => ({
            id: t.id,
            command: t.command,
            args: t.args,
            startPerformanceTime: t.startPerformanceTime,
            timestamp: t.timestamp ?? Date.now(),
            label: t.label ?? '',
            pid: t.childProcess.pid ?? 0,
        }));

        const historyTasks = this._processTracker.getHistory().map((t: JjProcessTask) => ({
            id: t.id,
            command: t.command,
            args: t.args,
            duration: t.duration ?? 0,
            status: t.status,
            label: t.label ?? '',
            error: t.error ?? '',
            stdout: t.stdout ?? '',
            stderr: t.stderr ?? '',
            exitCode: getTaskExitCode(t),
            timestamp: t.timestamp ?? Date.now(),
        }));

        const metrics = this._processTracker.getMetrics();

        this._onDidUpdate.fire();

        this._postMessage({
            type: 'update',
            payload: {
                activeTasks,
                historyTasks,
                metrics,
            },
        });
    }

    public getMetrics(): JjProcessMetrics {
        return this._processTracker.getMetrics();
    }

    public cancelProcess(id: number): void {
        this._processTracker.cancelProcess(id);
    }

    public cancelAllProcesses(): void {
        this._processTracker.cancelAllProcesses();
    }

    public clearHistory(): void {
        this._processTracker.clearHistory();
    }

    private _postMessage(message: ProcessMonitorHostToWebviewMessage): void {
        if (!this._disposed && this._messenger) {
            try {
                this._messenger.postMessage(message);
            } catch (e) {
                this._logger?.error(`[ProcessMonitorController] Failed to post message: ${e}`);
            }
        }
    }

    public dispose(): void {
        this._disposed = true;
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._onDidUpdate.dispose();
    }
}
