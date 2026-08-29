/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
    type ProcessMonitorActiveTask as ActiveTask,
    type ProcessMonitorHistoryTask as HistoryTask,
    type ProcessMonitorMetrics as Metrics,
    ProcessMonitorHostToWebviewMessageSchema,
    type ProcessMonitorToHostMessage,
    ProcessMonitorToHostMessageSchema,
} from '../../common/ipc/process-monitor-schemas';
import { useRpcReceiver, useRpcSender } from '../transport/BridgeContext';
import { getRelativeTimeString } from '../utils/time-utils';

export type { ActiveTask, HistoryTask, Metrics };

function ActiveDurationCell({ startPerformanceTime }: { startPerformanceTime: number }) {
    const [elapsedText, setElapsedText] = useState<string>(() => {
        const seconds = Math.max(0, (performance.now() - startPerformanceTime) / 1000).toFixed(1);
        return `${seconds}s`;
    });

    useEffect(() => {
        const update = () => {
            const seconds = Math.max(0, (performance.now() - startPerformanceTime) / 1000).toFixed(1);
            setElapsedText(`${seconds}s`);
        };
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, [startPerformanceTime]);

    return <td style={{ padding: '6px 8px' }}>{elapsedText}</td>;
}

function useRelativeTimeTooltip(timestamp: number) {
    const [tooltip, setTooltip] = useState<string>(() => (timestamp ? getRelativeTimeString(timestamp) : ''));

    useEffect(() => {
        if (timestamp) {
            setTooltip(getRelativeTimeString(timestamp));
        }
    }, [timestamp]);

    const handleMouseEnter = () => {
        if (timestamp) {
            setTooltip(getRelativeTimeString(timestamp));
        }
    };

    return { tooltip, handleMouseEnter };
}

function HistoryTimestampCell({ timestamp, fullTimestamp }: { timestamp: number; fullTimestamp: string }) {
    const { tooltip, handleMouseEnter } = useRelativeTimeTooltip(timestamp);

    return (
        <td
            title={tooltip}
            onMouseEnter={handleMouseEnter}
            style={{
                padding: '6px 8px',
                color: 'var(--vscode-descriptionForeground)',
            }}
        >
            {fullTimestamp}
        </td>
    );
}

function HistoryTimestampDetail({ timestamp, fullTimestamp }: { timestamp: number; fullTimestamp: string }) {
    const { tooltip, handleMouseEnter } = useRelativeTimeTooltip(timestamp);

    return (
        <b title={tooltip} onMouseEnter={handleMouseEnter} role="status">
            {fullTimestamp} ({tooltip})
        </b>
    );
}

export default function ProcessMonitorApp() {
    const sender = useRpcSender<ProcessMonitorToHostMessage, 'command'>(ProcessMonitorToHostMessageSchema, {
        discriminatorKey: 'command',
    });
    const [metrics, setMetrics] = useState<Metrics>({
        activeCount: 0,
        peakConcurrency: 0,
        totalCount: 0,
        avgDurationMs: 0,
    });
    const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
    const [historyTasks, setHistoryTasks] = useState<HistoryTask[]>([]);
    const [filter, setFilter] = useState<string>('');
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [copiedId, setCopiedId] = useState<string | null>(null);

    useRpcReceiver(ProcessMonitorHostToWebviewMessageSchema, {
        update: ({ activeTasks: tasks, historyTasks: history, metrics: currentMetrics }) => {
            setActiveTasks(tasks);
            setHistoryTasks(history);
            setMetrics(currentMetrics);
        },
    });

    useEffect(() => {
        void sender.webviewLoaded();
    }, [sender]);

    const toggleExpand = (rowKey: string, e: React.SyntheticEvent) => {
        e.stopPropagation();
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(rowKey)) {
                next.delete(rowKey);
            } else {
                next.add(rowKey);
            }
            return next;
        });
    };

    const handleKeyDownExpand = (rowKey: string, e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpand(rowKey, e);
        }
    };

    const handleKillProcess = (id: number, e: React.MouseEvent) => {
        e.stopPropagation();
        void sender.killProcess({ id });
    };

    const handleKillAll = () => {
        void sender.killAllProcesses();
    };

    const handleClearHistory = () => {
        void sender.clearHistory();
    };

    const handleHidePanel = () => {
        void sender.hidePanel();
    };

    const copyToClipboard = (text: string, key: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (navigator.clipboard) {
            navigator.clipboard
                .writeText(text)
                .then(() => {
                    setCopiedId(key);
                    setTimeout(() => setCopiedId(null), 2000);
                })
                .catch(() => {});
        }
    };

    const filterText = filter.toLowerCase();
    const filteredActive = activeTasks.filter(
        (t) => t.command.toLowerCase().includes(filterText) || t.label.toLowerCase().includes(filterText),
    );
    const filteredHistory = historyTasks.filter(
        (t) => t.command.toLowerCase().includes(filterText) || t.label.toLowerCase().includes(filterText),
    );

    return (
        <div style={{ padding: '8px 12px' }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    paddingBottom: 8,
                    borderBottom: '1px solid var(--vscode-panel-border, #333)',
                    marginBottom: 8,
                    flexWrap: 'wrap',
                }}
            >
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12 }}>
                    <span>
                        Active:{' '}
                        <span
                            style={{
                                backgroundColor: 'var(--vscode-badge-background, #333)',
                                color: 'var(--vscode-badge-foreground, #fff)',
                                padding: '2px 6px',
                                borderRadius: 4,
                                fontWeight: 600,
                            }}
                        >
                            {metrics.activeCount}
                        </span>
                    </span>
                    <span>
                        Peak:{' '}
                        <span
                            style={{
                                backgroundColor: 'var(--vscode-badge-background, #333)',
                                color: 'var(--vscode-badge-foreground, #fff)',
                                padding: '2px 6px',
                                borderRadius: 4,
                                fontWeight: 600,
                            }}
                        >
                            {metrics.peakConcurrency}
                        </span>
                    </span>
                    <span>
                        Total:{' '}
                        <span
                            style={{
                                backgroundColor: 'var(--vscode-badge-background, #333)',
                                color: 'var(--vscode-badge-foreground, #fff)',
                                padding: '2px 6px',
                                borderRadius: 4,
                                fontWeight: 600,
                            }}
                        >
                            {metrics.totalCount}
                        </span>
                    </span>
                    <span>
                        Avg:{' '}
                        <span
                            style={{
                                backgroundColor: 'var(--vscode-badge-background, #333)',
                                color: 'var(--vscode-badge-foreground, #fff)',
                                padding: '2px 6px',
                                borderRadius: 4,
                                fontWeight: 600,
                            }}
                        >
                            {metrics.avgDurationMs}ms
                        </span>
                    </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter commands..."
                        style={{
                            backgroundColor: 'var(--vscode-input-background)',
                            color: 'var(--vscode-input-foreground)',
                            border: '1px solid var(--vscode-input-border, #444)',
                            padding: '4px 8px',
                            borderRadius: 2,
                            fontSize: 12,
                            width: 180,
                        }}
                    />
                    <button
                        type="button"
                        onClick={handleKillAll}
                        style={{
                            backgroundColor: 'var(--vscode-errorForeground, #e51400)',
                            color: '#fff',
                            border: 'none',
                            padding: '4px 10px',
                            borderRadius: 2,
                            cursor: 'pointer',
                            fontSize: 12,
                        }}
                    >
                        Kill All
                    </button>
                    <button
                        type="button"
                        onClick={handleClearHistory}
                        style={{
                            backgroundColor: 'var(--vscode-button-secondaryBackground, #444)',
                            color: 'var(--vscode-button-secondaryForeground, #fff)',
                            border: 'none',
                            padding: '4px 10px',
                            borderRadius: 2,
                            cursor: 'pointer',
                            fontSize: 12,
                        }}
                    >
                        Clear History
                    </button>
                    <button
                        type="button"
                        onClick={handleHidePanel}
                        style={{
                            backgroundColor: 'var(--vscode-button-secondaryBackground, #444)',
                            color: 'var(--vscode-button-secondaryForeground, #fff)',
                            border: 'none',
                            padding: '4px 10px',
                            borderRadius: 2,
                            cursor: 'pointer',
                            fontSize: 12,
                        }}
                    >
                        Hide Panel
                    </button>
                </div>
            </div>

            <section style={{ marginBottom: 12 }}>
                <h3
                    style={{
                        fontSize: 12,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        color: 'var(--vscode-descriptionForeground)',
                        margin: '6px 0',
                    }}
                >
                    ⚡ Running Processes ({filteredActive.length})
                </h3>
                {filteredActive.length === 0 ? (
                    <div
                        style={{ color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', padding: '6px 0' }}
                    >
                        No active running processes.
                    </div>
                ) : (
                    <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--vscode-panel-border, #222)' }}>
                                <th style={{ width: 24 }} />
                                <th style={{ width: 60, textAlign: 'left', padding: '6px 8px' }}>PID</th>
                                <th style={{ width: 140, textAlign: 'left', padding: '6px 8px' }}>Label</th>
                                <th style={{ width: 75, textAlign: 'left', padding: '6px 8px' }}>Duration</th>
                                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Command</th>
                                <th style={{ width: 50, textAlign: 'left', padding: '6px 8px' }}>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredActive.map((t) => {
                                const rowKey = `active-${t.id}`;
                                const isExpanded = expandedIds.has(rowKey);

                                return (
                                    <React.Fragment key={rowKey}>
                                        <tr
                                            tabIndex={0}
                                            aria-expanded={isExpanded}
                                            onClick={(e) => toggleExpand(rowKey, e)}
                                            onKeyDown={(e) => handleKeyDownExpand(rowKey, e)}
                                            style={{
                                                cursor: 'pointer',
                                                borderBottom: '1px solid var(--vscode-panel-border, #222)',
                                                backgroundColor: isExpanded
                                                    ? 'var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.08))'
                                                    : undefined,
                                            }}
                                        >
                                            <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                                <span
                                                    style={{
                                                        display: 'inline-block',
                                                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                                                        transition: 'transform 0.15s ease',
                                                        fontSize: 10,
                                                    }}
                                                >
                                                    ▶
                                                </span>
                                            </td>
                                            <td style={{ padding: '6px 8px' }}>{t.pid || '-'}</td>
                                            <td
                                                title={t.label || ''}
                                                style={{
                                                    padding: '6px 8px',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    maxWidth: 0,
                                                }}
                                            >
                                                {t.label || '-'}
                                            </td>
                                            <ActiveDurationCell startPerformanceTime={t.startPerformanceTime} />
                                            <td
                                                title={t.command}
                                                style={{
                                                    padding: '6px 8px',
                                                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    maxWidth: 0,
                                                }}
                                            >
                                                {t.command}
                                            </td>
                                            <td style={{ padding: '6px 8px' }}>
                                                <button
                                                    type="button"
                                                    onClick={(e) => handleKillProcess(t.id, e)}
                                                    style={{
                                                        backgroundColor: 'var(--vscode-errorForeground, #e51400)',
                                                        color: '#fff',
                                                        border: 'none',
                                                        padding: '3px 8px',
                                                        borderRadius: 2,
                                                        cursor: 'pointer',
                                                        fontSize: 11,
                                                    }}
                                                >
                                                    Kill
                                                </button>
                                            </td>
                                        </tr>
                                        {isExpanded && (
                                            <tr style={{ borderBottom: '1px solid var(--vscode-panel-border, #333)' }}>
                                                <td
                                                    colSpan={6}
                                                    style={{
                                                        padding: '8px 12px 12px 12px',
                                                        backgroundColor:
                                                            'var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.2))',
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                        <div
                                                            style={{
                                                                display: 'flex',
                                                                justifyContent: 'space-between',
                                                                alignItems: 'center',
                                                            }}
                                                        >
                                                            <div
                                                                style={{
                                                                    fontSize: 11,
                                                                    color: 'var(--vscode-descriptionForeground)',
                                                                }}
                                                            >
                                                                PID: <b>{t.pid || '-'}</b> | Label:{' '}
                                                                <b>{t.label || 'none'}</b>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => copyToClipboard(t.command, rowKey, e)}
                                                                style={{
                                                                    backgroundColor:
                                                                        'var(--vscode-button-secondaryBackground, #444)',
                                                                    color: 'var(--vscode-button-secondaryForeground, #fff)',
                                                                    border: 'none',
                                                                    padding: '2px 6px',
                                                                    borderRadius: 2,
                                                                    fontSize: 11,
                                                                    cursor: 'pointer',
                                                                }}
                                                            >
                                                                {copiedId === rowKey ? '✓ Copied' : 'Copy Command'}
                                                            </button>
                                                        </div>
                                                        <div>
                                                            <div
                                                                style={{
                                                                    fontSize: 11,
                                                                    fontWeight: 'bold',
                                                                    color: 'var(--vscode-descriptionForeground)',
                                                                    marginBottom: 4,
                                                                }}
                                                            >
                                                                Full Executed Command:
                                                            </div>
                                                            <div
                                                                style={{
                                                                    fontFamily:
                                                                        'var(--vscode-editor-font-family, monospace)',
                                                                    fontSize: 12,
                                                                    backgroundColor: 'var(--vscode-editor-background)',
                                                                    border: '1px solid var(--vscode-widget-border, #333)',
                                                                    borderRadius: 4,
                                                                    padding: 8,
                                                                    whiteSpace: 'pre-wrap',
                                                                    wordBreak: 'break-all',
                                                                }}
                                                            >
                                                                {t.command}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </section>

            <section style={{ marginBottom: 12 }}>
                <h3
                    style={{
                        fontSize: 12,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        color: 'var(--vscode-descriptionForeground)',
                        margin: '6px 0',
                    }}
                >
                    📜 History ({filteredHistory.length})
                </h3>
                {filteredHistory.length === 0 ? (
                    <div
                        style={{ color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', padding: '6px 0' }}
                    >
                        No history recorded yet.
                    </div>
                ) : (
                    <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--vscode-panel-border, #222)' }}>
                                <th style={{ width: 24 }} />
                                <th style={{ width: 85, textAlign: 'left', padding: '6px 8px' }}>Status</th>
                                <th style={{ width: 140, textAlign: 'left', padding: '6px 8px' }}>Label</th>
                                <th style={{ width: 75, textAlign: 'left', padding: '6px 8px' }}>Duration</th>
                                <th style={{ width: 85, textAlign: 'left', padding: '6px 8px' }}>Time</th>
                                <th style={{ textAlign: 'left', padding: '6px 8px' }}>Command</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredHistory.map((t) => {
                                const rowKey = `history-${t.id}`;
                                const isExpanded = expandedIds.has(rowKey);
                                const statusColor = getStatusColor(t.status);
                                const fullTimestamp = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '-';

                                return (
                                    <React.Fragment key={rowKey}>
                                        <tr
                                            tabIndex={0}
                                            aria-expanded={isExpanded}
                                            onClick={(e) => toggleExpand(rowKey, e)}
                                            onKeyDown={(e) => handleKeyDownExpand(rowKey, e)}
                                            style={{
                                                cursor: 'pointer',
                                                borderBottom: '1px solid var(--vscode-panel-border, #222)',
                                                backgroundColor: isExpanded
                                                    ? 'var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.08))'
                                                    : undefined,
                                            }}
                                        >
                                            <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                                <span
                                                    style={{
                                                        display: 'inline-block',
                                                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                                                        transition: 'transform 0.15s ease',
                                                        fontSize: 10,
                                                    }}
                                                >
                                                    ▶
                                                </span>
                                            </td>
                                            <td style={{ padding: '6px 8px', color: statusColor, fontWeight: 600 }}>
                                                {t.status}
                                            </td>
                                            <td
                                                title={t.label || ''}
                                                style={{
                                                    padding: '6px 8px',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    maxWidth: 0,
                                                }}
                                            >
                                                {t.label || '-'}
                                            </td>
                                            <td style={{ padding: '6px 8px' }}>{t.duration}ms</td>
                                            <HistoryTimestampCell
                                                timestamp={t.timestamp}
                                                fullTimestamp={fullTimestamp}
                                            />
                                            <td
                                                title={t.command}
                                                style={{
                                                    padding: '6px 8px',
                                                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    maxWidth: 0,
                                                }}
                                            >
                                                {t.command}
                                            </td>
                                        </tr>
                                        {isExpanded && (
                                            <tr style={{ borderBottom: '1px solid var(--vscode-panel-border, #333)' }}>
                                                <td
                                                    colSpan={6}
                                                    style={{
                                                        padding: '8px 12px 12px 12px',
                                                        backgroundColor:
                                                            'var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.2))',
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                        <div
                                                            style={{
                                                                display: 'flex',
                                                                justifyContent: 'space-between',
                                                                alignItems: 'center',
                                                            }}
                                                        >
                                                            <div
                                                                style={{
                                                                    fontSize: 11,
                                                                    color: 'var(--vscode-descriptionForeground)',
                                                                }}
                                                            >
                                                                Status: <b style={{ color: statusColor }}>{t.status}</b>{' '}
                                                                | Exit Code: <b>{t.exitCode}</b> | Duration:{' '}
                                                                <b>{t.duration}ms</b> | Time:{' '}
                                                                <HistoryTimestampDetail
                                                                    timestamp={t.timestamp}
                                                                    fullTimestamp={fullTimestamp}
                                                                />{' '}
                                                                | Label: <b>{t.label || 'none'}</b>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => copyToClipboard(t.command, rowKey, e)}
                                                                style={{
                                                                    backgroundColor:
                                                                        'var(--vscode-button-secondaryBackground, #444)',
                                                                    color: 'var(--vscode-button-secondaryForeground, #fff)',
                                                                    border: 'none',
                                                                    padding: '2px 6px',
                                                                    borderRadius: 2,
                                                                    fontSize: 11,
                                                                    cursor: 'pointer',
                                                                }}
                                                            >
                                                                {copiedId === rowKey ? '✓ Copied' : 'Copy Command'}
                                                            </button>
                                                        </div>
                                                        <div>
                                                            <div
                                                                style={{
                                                                    fontSize: 11,
                                                                    fontWeight: 'bold',
                                                                    color: 'var(--vscode-descriptionForeground)',
                                                                    marginBottom: 4,
                                                                }}
                                                            >
                                                                Full Executed Command:
                                                            </div>
                                                            <div
                                                                style={{
                                                                    fontFamily:
                                                                        'var(--vscode-editor-font-family, monospace)',
                                                                    fontSize: 12,
                                                                    backgroundColor: 'var(--vscode-editor-background)',
                                                                    border: '1px solid var(--vscode-widget-border, #333)',
                                                                    borderRadius: 4,
                                                                    padding: 8,
                                                                    whiteSpace: 'pre-wrap',
                                                                    wordBreak: 'break-all',
                                                                }}
                                                            >
                                                                {t.command}
                                                            </div>
                                                        </div>
                                                        {t.stdout !== undefined && (
                                                            <div>
                                                                <div
                                                                    style={{
                                                                        display: 'flex',
                                                                        justifyContent: 'space-between',
                                                                        alignItems: 'center',
                                                                        marginBottom: 4,
                                                                    }}
                                                                >
                                                                    <div
                                                                        style={{
                                                                            fontSize: 11,
                                                                            fontWeight: 'bold',
                                                                            color: 'var(--vscode-descriptionForeground)',
                                                                        }}
                                                                    >
                                                                        Standard Output (stdout):
                                                                    </div>
                                                                    {t.stdout ? (
                                                                        <button
                                                                            type="button"
                                                                            onClick={(e) =>
                                                                                copyToClipboard(
                                                                                    t.stdout,
                                                                                    `${rowKey}-out`,
                                                                                    e,
                                                                                )
                                                                            }
                                                                            style={{
                                                                                backgroundColor:
                                                                                    'var(--vscode-button-secondaryBackground, #444)',
                                                                                color: 'var(--vscode-button-secondaryForeground, #fff)',
                                                                                border: 'none',
                                                                                padding: '2px 6px',
                                                                                borderRadius: 2,
                                                                                fontSize: 11,
                                                                                cursor: 'pointer',
                                                                            }}
                                                                        >
                                                                            {copiedId === `${rowKey}-out`
                                                                                ? '✓ Copied'
                                                                                : 'Copy Output'}
                                                                        </button>
                                                                    ) : null}
                                                                </div>
                                                                <div
                                                                    style={{
                                                                        fontFamily:
                                                                            'var(--vscode-editor-font-family, monospace)',
                                                                        fontSize: 12,
                                                                        backgroundColor:
                                                                            'var(--vscode-editor-background)',
                                                                        border: '1px solid var(--vscode-widget-border, #333)',
                                                                        borderRadius: 4,
                                                                        padding: 8,
                                                                        maxHeight: 200,
                                                                        overflowY: 'auto',
                                                                        whiteSpace: 'pre-wrap',
                                                                        wordBreak: 'break-all',
                                                                    }}
                                                                >
                                                                    {t.stdout || (
                                                                        <span
                                                                            style={{
                                                                                fontStyle: 'italic',
                                                                                opacity: 0.7,
                                                                            }}
                                                                        >
                                                                            (empty output)
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        )}
                                                        {(t.stderr || t.error) && (
                                                            <div>
                                                                <div
                                                                    style={{
                                                                        fontSize: 11,
                                                                        fontWeight: 'bold',
                                                                        color: 'var(--vscode-errorForeground, #f14c4c)',
                                                                        marginBottom: 4,
                                                                    }}
                                                                >
                                                                    Standard Error / Error Message:
                                                                </div>
                                                                <div
                                                                    style={{
                                                                        fontFamily:
                                                                            'var(--vscode-editor-font-family, monospace)',
                                                                        fontSize: 12,
                                                                        backgroundColor:
                                                                            'var(--vscode-editor-background)',
                                                                        border: '1px solid var(--vscode-inputValidation-errorBorder, #f14c4c)',
                                                                        color: 'var(--vscode-errorForeground, #f14c4c)',
                                                                        borderRadius: 4,
                                                                        padding: 8,
                                                                        maxHeight: 200,
                                                                        overflowY: 'auto',
                                                                        whiteSpace: 'pre-wrap',
                                                                        wordBreak: 'break-all',
                                                                    }}
                                                                >
                                                                    {t.stderr || t.error}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
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
