<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import {
    type ProcessMonitorActiveTask as ActiveTask,
    type ProcessMonitorHistoryTask as HistoryTask,
    type ProcessMonitorMetrics as Metrics,
    ProcessMonitorHostToWebviewMessageSchema,
    type ProcessMonitorToHostMessage,
    ProcessMonitorToHostMessageSchema,
} from '../../host/ipc/process-monitor-schemas';
import { getRelativeTimeString } from '../common/utils/time-utils';
import { useRpcReceiver, useRpcSender } from '../transport/bridge.svelte';

export type { ActiveTask, HistoryTask, Metrics };

const sender = useRpcSender<ProcessMonitorToHostMessage, 'command'>(ProcessMonitorToHostMessageSchema, {
    discriminatorKey: 'command',
});

let metrics = $state<Metrics>({
    activeCount: 0,
    peakConcurrency: 0,
    totalCount: 0,
    avgDurationMs: 0,
});
let activeTasks = $state<ActiveTask[]>([]);
let historyTasks = $state<HistoryTask[]>([]);
let filter = $state<string>('');
let expandedIds = $state<Set<string>>(new Set());
let copiedId = $state<string | null>(null);

// Live elapsed timer that runs only while there are active tasks
const hasActiveTasks = $derived(activeTasks.length > 0);
let now = $state(Date.now());
$effect(() => {
    if (!hasActiveTasks) {
        return;
    }
    now = Date.now();
    const timer = setInterval(() => {
        now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
});

useRpcReceiver(ProcessMonitorHostToWebviewMessageSchema, {
    update: ({ activeTasks: tasks, historyTasks: history, metrics: currentMetrics }) => {
        activeTasks = tasks;
        historyTasks = history;
        metrics = currentMetrics;
    },
});

$effect(() => {
    void sender.webviewLoaded();
});

function toggleExpand(rowKey: string, e: Event) {
    e.stopPropagation();
    const next = new Set(expandedIds);
    if (next.has(rowKey)) {
        next.delete(rowKey);
    } else {
        next.add(rowKey);
    }
    expandedIds = next;
}

function handleKeyDownExpand(rowKey: string, e: KeyboardEvent) {
    if ((e.target as HTMLElement | null)?.closest('button, a, input, textarea, select')) {
        return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleExpand(rowKey, e);
    }
}

function handleKillProcess(id: number, e: MouseEvent) {
    e.stopPropagation();
    void sender.killProcess({ id });
}

function handleKillAll() {
    void sender.killAllProcesses();
}

function handleClearHistory() {
    void sender.clearHistory();
}

function handleHidePanel() {
    void sender.hidePanel();
}

function copyToClipboard(text: string, key: string, e: MouseEvent) {
    e.stopPropagation();
    if (navigator.clipboard) {
        navigator.clipboard
            .writeText(text)
            .then(() => {
                copiedId = key;
                setTimeout(() => {
                    if (copiedId === key) {
                        copiedId = null;
                    }
                }, 2000);
            })
            .catch(() => {});
    }
}

let filterText = $derived(filter.toLowerCase());
let filteredActive = $derived(
    activeTasks.filter(
        (t) => t.command.toLowerCase().includes(filterText) || t.label.toLowerCase().includes(filterText),
    ),
);
let filteredHistory = $derived(
    historyTasks.filter(
        (t) => t.command.toLowerCase().includes(filterText) || t.label.toLowerCase().includes(filterText),
    ),
);

function formatActiveDuration(startTime: number, currentTime: number): string {
    const seconds = Math.max(0, (currentTime - startTime) / 1000).toFixed(1);
    return `${seconds}s`;
}

function getStatusColor(status: string): string {
    switch (status) {
        case 'completed':
            return 'var(--vscode-testing-iconPassed, #73c991)';
        case 'failed':
            return 'var(--vscode-testing-iconFailed, #f14c4c)';
        case 'timed_out':
            return 'var(--vscode-charts-orange, #dda853)';
        case 'cancelled':
            return 'var(--vscode-disabledForeground, #888)';
        default:
            return 'var(--vscode-foreground)';
    }
}
</script>

<div class="process-monitor-container">
    <!-- Header Controls & Metrics -->
    <div class="monitor-header">
        <div class="metrics-row">
            <span>
                Active: <span class="badge">{metrics.activeCount}</span>
            </span>
            <span>
                Peak: <span class="badge">{metrics.peakConcurrency}</span>
            </span>
            <span>
                Total: <span class="badge">{metrics.totalCount}</span>
            </span>
            <span>
                Avg: <span class="badge">{metrics.avgDurationMs}ms</span>
            </span>
        </div>
        <div class="controls-row">
            <input
                type="text"
                bind:value={filter}
                placeholder="Filter commands..."
                class="filter-input"
            />
            <button type="button" class="btn btn-danger" onclick={handleKillAll}>
                Kill All
            </button>
            <button type="button" class="btn btn-secondary" onclick={handleClearHistory}>
                Clear History
            </button>
            <button type="button" class="btn btn-secondary" onclick={handleHidePanel}>
                Hide Panel
            </button>
        </div>
    </div>

    <!-- Running Processes Section -->
    <section class="monitor-section">
        <h3 class="section-title">
            ⚡ Running Processes ({filteredActive.length})
        </h3>
        {#if filteredActive.length === 0}
            <div class="empty-state">
                No active running processes.
            </div>
        {:else}
            <table class="tasks-table">
                <thead>
                    <tr>
                        <th class="col-expand"></th>
                        <th class="col-pid">PID</th>
                        <th class="col-label">Label</th>
                        <th class="col-duration">Duration</th>
                        <th class="col-command">Command</th>
                        <th class="col-action">Action</th>
                    </tr>
                </thead>
                <tbody>
                    {#each filteredActive as t (t.id)}
                        {@const rowKey = `active-${t.id}`}
                        {@const isExpanded = expandedIds.has(rowKey)}
                        <tr
                            tabindex="0"
                            aria-expanded={isExpanded}
                            class="task-row"
                            class:expanded={isExpanded}
                            onclick={(e) => toggleExpand(rowKey, e)}
                            onkeydown={(e) => handleKeyDownExpand(rowKey, e)}
                        >
                            <td class="cell-expand">
                                <span class="arrow" class:rotated={isExpanded}>▶</span>
                            </td>
                            <td class="cell-pid">{t.pid || '-'}</td>
                            <td class="cell-label" title={t.label || ''}>{t.label || '-'}</td>
                            <td class="cell-duration">{formatActiveDuration(t.timestamp, now)}</td>
                            <td class="cell-command" title={t.command}>{t.command}</td>
                            <td class="cell-action">
                                <button
                                    type="button"
                                    class="btn-kill"
                                    onclick={(e) => handleKillProcess(t.id, e)}
                                    onkeydown={(e) => e.stopPropagation()}
                                >
                                    Kill
                                </button>
                            </td>
                        </tr>
                        {#if isExpanded}
                            <tr class="detail-row">
                                <td colspan="6">
                                    <div class="detail-content">
                                        <div class="detail-header">
                                            <div class="detail-meta">
                                                PID: <b>{t.pid || '-'}</b> | Label: <b>{t.label || 'none'}</b>
                                            </div>
                                            <button
                                                type="button"
                                                class="btn-copy"
                                                onclick={(e) => copyToClipboard(t.command, rowKey, e)}
                                            >
                                                {copiedId === rowKey ? '✓ Copied' : 'Copy Command'}
                                            </button>
                                        </div>
                                        <div>
                                            <div class="detail-subhead">Full Executed Command:</div>
                                            <div class="code-block">{t.command}</div>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        {/if}
                    {/each}
                </tbody>
            </table>
        {/if}
    </section>

    <!-- History Section -->
    <section class="monitor-section">
        <h3 class="section-title">
            📜 History ({filteredHistory.length})
        </h3>
        {#if filteredHistory.length === 0}
            <div class="empty-state">
                No history recorded yet.
            </div>
        {:else}
            <table class="tasks-table">
                <thead>
                    <tr>
                        <th class="col-expand"></th>
                        <th class="col-status">Status</th>
                        <th class="col-label">Label</th>
                        <th class="col-duration">Duration</th>
                        <th class="col-time">Time</th>
                        <th class="col-command">Command</th>
                    </tr>
                </thead>
                <tbody>
                    {#each filteredHistory as t (t.id)}
                        {@const rowKey = `history-${t.id}`}
                        {@const isExpanded = expandedIds.has(rowKey)}
                        {@const statusColor = getStatusColor(t.status)}
                        {@const fullTimestamp = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '-'}
                        {@const relTooltip = t.timestamp ? getRelativeTimeString(t.timestamp) : ''}
                        <tr
                            tabindex="0"
                            aria-expanded={isExpanded}
                            class="task-row"
                            class:expanded={isExpanded}
                            onclick={(e) => toggleExpand(rowKey, e)}
                            onkeydown={(e) => handleKeyDownExpand(rowKey, e)}
                        >
                            <td class="cell-expand">
                                <span class="arrow" class:rotated={isExpanded}>▶</span>
                            </td>
                            <td class="cell-status" style:color={statusColor}>{t.status}</td>
                            <td class="cell-label" title={t.label || ''}>{t.label || '-'}</td>
                            <td class="cell-duration">{t.duration}ms</td>
                            <td class="cell-time" title={relTooltip}>{fullTimestamp}</td>
                            <td class="cell-command" title={t.command}>{t.command}</td>
                        </tr>
                        {#if isExpanded}
                            <tr class="detail-row">
                                <td colspan="6">
                                    <div class="detail-content">
                                        <div class="detail-header">
                                            <div class="detail-meta">
                                                Status: <b style:color={statusColor}>{t.status}</b> | Exit Code: <b>{t.exitCode}</b> | Duration: <b>{t.duration}ms</b> | Time: <b title={relTooltip} role="status">{fullTimestamp} ({relTooltip})</b> | Label: <b>{t.label || 'none'}</b>
                                            </div>
                                            <button
                                                type="button"
                                                class="btn-copy"
                                                onclick={(e) => copyToClipboard(t.command, rowKey, e)}
                                            >
                                                {copiedId === rowKey ? '✓ Copied' : 'Copy Command'}
                                            </button>
                                        </div>
                                        <div>
                                            <div class="detail-subhead">Full Executed Command:</div>
                                            <div class="code-block">{t.command}</div>
                                        </div>
                                        {#if t.stdout !== undefined}
                                            <div>
                                                <div class="detail-header">
                                                    <div class="detail-subhead">Standard Output (stdout):</div>
                                                    {#if t.stdout}
                                                        <button
                                                            type="button"
                                                            class="btn-copy"
                                                            onclick={(e) => copyToClipboard(t.stdout ?? '', `${rowKey}-out`, e)}
                                                        >
                                                            {copiedId === `${rowKey}-out` ? '✓ Copied' : 'Copy Output'}
                                                        </button>
                                                    {/if}
                                                </div>
                                                <div class="code-block stdout-block">
                                                    {#if t.stdout}
                                                        {t.stdout}
                                                    {:else}
                                                        <span class="empty-output">(empty output)</span>
                                                    {/if}
                                                </div>
                                            </div>
                                        {/if}
                                        {#if t.stderr || t.error}
                                            <div>
                                                <div class="detail-subhead error-subhead">Standard Error / Error Message:</div>
                                                <div class="code-block stderr-block">
                                                    {t.stderr || t.error}
                                                </div>
                                            </div>
                                        {/if}
                                    </div>
                                </td>
                            </tr>
                        {/if}
                    {/each}
                </tbody>
            </table>
        {/if}
    </section>
</div>

<style>
    .process-monitor-container {
        padding: 8px 12px;
    }

    .monitor-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        margin-bottom: 8px;
        flex-wrap: wrap;
    }

    .metrics-row {
        display: flex;
        gap: 12px;
        align-items: center;
        font-size: 12px;
    }

    .badge {
        background-color: var(--vscode-badge-background, #333);
        color: var(--vscode-badge-foreground, #fff);
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 600;
    }

    .controls-row {
        display: flex;
        gap: 6px;
    }

    .filter-input {
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #444);
        padding: 4px 8px;
        border-radius: 2px;
        font-size: 12px;
        width: 180px;
    }

    .btn {
        border: none;
        padding: 4px 10px;
        border-radius: 2px;
        cursor: pointer;
        font-size: 12px;
    }

    .btn-danger {
        background-color: var(--vscode-errorForeground, #e51400);
        color: #fff;
    }

    .btn-secondary {
        background-color: var(--vscode-button-secondaryBackground, #444);
        color: var(--vscode-button-secondaryForeground, #fff);
    }

    .monitor-section {
        margin-bottom: 12px;
    }

    .section-title {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        margin: 6px 0;
    }

    .empty-state {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        padding: 6px 0;
    }

    .tasks-table {
        width: 100%;
        table-layout: fixed;
        border-collapse: collapse;
        font-size: 12px;
    }

    .tasks-table thead tr {
        border-bottom: 1px solid var(--vscode-panel-border, #222);
    }

    .tasks-table th {
        text-align: left;
        padding: 6px 8px;
    }

    .col-expand { width: 24px; }
    .col-pid { width: 60px; }
    .col-status { width: 85px; }
    .col-label { width: 140px; }
    .col-duration { width: 75px; }
    .col-time { width: 85px; }
    .col-action { width: 50px; }

    .task-row {
        cursor: pointer;
        border-bottom: 1px solid var(--vscode-panel-border, #222);
    }

    .task-row.expanded {
        background-color: var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.08));
    }

    .cell-expand {
        padding: 6px 4px;
        text-align: center;
    }

    .arrow {
        display: inline-block;
        transition: transform 0.15s ease;
        font-size: 10px;
    }

    .arrow.rotated {
        transform: rotate(90deg);
    }

    .cell-pid, .cell-duration {
        padding: 6px 8px;
    }

    .cell-status {
        padding: 6px 8px;
        font-weight: 600;
    }

    .cell-time {
        padding: 6px 8px;
        color: var(--vscode-descriptionForeground);
    }

    .cell-label {
        padding: 6px 8px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 0;
    }

    .cell-command {
        padding: 6px 8px;
        font-family: var(--vscode-editor-font-family, monospace);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 0;
    }

    .cell-action {
        padding: 6px 8px;
    }

    .btn-kill {
        background-color: var(--vscode-errorForeground, #e51400);
        color: #fff;
        border: none;
        padding: 3px 8px;
        border-radius: 2px;
        cursor: pointer;
        font-size: 11px;
    }

    .detail-row {
        border-bottom: 1px solid var(--vscode-panel-border, #333);
    }

    .detail-row td {
        padding: 8px 12px 12px 12px;
        background-color: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.2));
    }

    .detail-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .detail-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
    }

    .detail-meta {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }

    .btn-copy {
        background-color: var(--vscode-button-secondaryBackground, #444);
        color: var(--vscode-button-secondaryForeground, #fff);
        border: none;
        padding: 2px 6px;
        border-radius: 2px;
        font-size: 11px;
        cursor: pointer;
    }

    .detail-subhead {
        font-size: 11px;
        font-weight: bold;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 4px;
    }

    .error-subhead {
        color: var(--vscode-errorForeground, #f14c4c);
    }

    .code-block {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        background-color: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border, #333);
        border-radius: 4px;
        padding: 8px;
        white-space: pre-wrap;
        word-break: break-all;
    }

    .stdout-block {
        max-height: 200px;
        overflow-y: auto;
    }

    .empty-output {
        font-style: italic;
        opacity: 0.7;
    }

    .stderr-block {
        max-height: 200px;
        overflow-y: auto;
        border-color: var(--vscode-inputValidation-errorBorder, #f14c4c);
        color: var(--vscode-errorForeground, #f14c4c);
    }
</style>
