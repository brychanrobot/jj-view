/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoalescingQueue } from '../../utils/coalescing-queue';
import { toError } from '../../utils/error-utils';
import type { LoggerChannel } from '../../utils/output-channel';
import { type Disposable, type Event, EventEmitter } from '../host/events';
import type { HostEnvironment } from '../host/host-environment';
import {
    type ProcessMonitorHostToWebviewMessage,
    type ProcessMonitorPayload,
    type ProcessMonitorToHostMessage,
    ProcessMonitorToHostMessageSchema,
} from '../host/ipc/process-monitor-schemas';
import {
    createWebviewRpcReceiver,
    type WebviewPostMessageLike,
    type WebviewRpcReceiver,
} from '../host/webview-rpc-dispatcher';
import {
    getTaskExitCode,
    type JjProcessMetrics,
    type JjProcessTask,
    type JjProcessTracker,
} from '../jj-process-tracker';

export interface ProcessMonitorControllerOptions {
    messenger?: WebviewPostMessageLike;
    logger?: LoggerChannel;
}

export class ProcessMonitorController implements Disposable {
    private _disposed = false;
    private readonly _disposables: Disposable[] = [];
    private readonly _logger?: LoggerChannel;
    private readonly _updateQueue: CoalescingQueue;
    private readonly _receiver: WebviewRpcReceiver<
        ProcessMonitorToHostMessage,
        ProcessMonitorHostToWebviewMessage,
        'command'
    >;

    private readonly _onDidUpdate = new EventEmitter<void>();
    public readonly onDidUpdate: Event<void> = this._onDidUpdate.event;

    constructor(
        private readonly _processTracker: JjProcessTracker,
        private readonly _host: HostEnvironment,
        options?: ProcessMonitorControllerOptions,
    ) {
        this._logger = options?.logger;

        this._updateQueue = new CoalescingQueue(async () => {
            try {
                this.updateWebview();
            } catch (err) {
                this._logger?.error('ProcessMonitorController updateWebview error', toError(err));
            }
        });

        this._disposables.push(
            this._processTracker.onDidChangeProcesses(() => {
                if (this._disposed) {
                    return;
                }
                this._updateQueue.run().catch((err) => {
                    this._logger?.error('ProcessMonitorController update queue run failed', toError(err));
                });
            }),
        );

        this._receiver = createWebviewRpcReceiver<
            ProcessMonitorToHostMessage,
            ProcessMonitorHostToWebviewMessage,
            'command'
        >(
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
                getState: () => this.getState(),
            },
        );

        if (options?.messenger) {
            this._receiver.setMessenger(options.messenger);
        }

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

    public getState(): ProcessMonitorPayload {
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

        return {
            activeTasks,
            historyTasks,
            metrics,
        };
    }

    public setMessenger(messenger: WebviewPostMessageLike | undefined): void {
        this._receiver.setMessenger(messenger);
    }

    public async handleMessage(rawMessage: unknown): Promise<boolean> {
        if (this._disposed) {
            return false;
        }
        return this._receiver.dispatch(rawMessage);
    }

    public updateWebview(): void {
        if (this._disposed) {
            return;
        }

        this._onDidUpdate.fire();
        this._receiver.sender.update(this.getState());
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

    public dispose(): void {
        this._disposed = true;
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._onDidUpdate.dispose();
        this._receiver.dispose();
    }
}
