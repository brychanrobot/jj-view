<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import { writeClipboardText } from '../../../src/utils/clipboard';
import {
    type LogLevel,
    type OutputLogEntry,
    splitHighlightSegments,
    tokenizeLogText,
    type WebOutputChannel,
} from './web-output-channel';

interface Props {
    channel: WebOutputChannel;
    onClose?: () => void;
}

let { channel, onClose }: Props = $props();

export type LevelFilterMode = 'all' | 'error' | 'warn' | 'info' | 'debug';

// svelte-ignore state_referenced_locally
let entries = $state<readonly OutputLogEntry[]>(channel.entries);
let filterQuery = $state('');
let levelFilter = $state<LevelFilterMode>('all');
let sourceFilter = $state<string>('all');
let autoScroll = $state(true);
let wordWrap = $state(true);
let copiedFeedback = $state(false);
let manualCollapsedIds = $state<Set<number>>(new Set());
let manualExpandedIds = $state<Set<number>>(new Set());
let logListEl = $state<HTMLElement | null>(null);

let unsubscribeEntries: (() => void) | null = null;

onMount(() => {
    entries = channel.entries;
    const sub = channel.onDidChangeEntries((updated) => {
        entries = updated;
        if (autoScroll) {
            void tick().then(() => {
                if (logListEl) {
                    logListEl.scrollTop = logListEl.scrollHeight;
                }
            });
        }
    });
    unsubscribeEntries = sub.dispose;

    if (autoScroll && logListEl) {
        logListEl.scrollTop = logListEl.scrollHeight;
    }
});

onDestroy(() => {
    if (unsubscribeEntries) {
        unsubscribeEntries();
    }
});

const availableSources = $derived.by((): string[] => {
    const set = new Set<string>();
    for (const entry of entries) {
        if (entry.source) {
            set.add(entry.source);
        }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
});

const errorCount = $derived(entries.filter((e) => e.level === 'error').length);
const warnCount = $derived(entries.filter((e) => e.level === 'warn').length);

function matchesLevel(level: LogLevel, mode: LevelFilterMode): boolean {
    if (mode === 'all') {
        return true;
    }
    if (mode === 'error') {
        return level === 'error';
    }
    if (mode === 'warn') {
        return level === 'warn' || level === 'error';
    }
    if (mode === 'info') {
        return level === 'info' || level === 'warn' || level === 'error';
    }
    return level === 'debug' || level === 'trace';
}

const filteredEntries = $derived.by((): readonly OutputLogEntry[] => {
    const q = filterQuery.trim().toLowerCase();
    return entries.filter((entry) => {
        if (!matchesLevel(entry.level, levelFilter)) {
            return false;
        }
        if (sourceFilter !== 'all' && entry.source !== sourceFilter) {
            return false;
        }
        if (!q) {
            return true;
        }
        return (
            entry.message.toLowerCase().includes(q) ||
            entry.source.toLowerCase().includes(q) ||
            entry.level.toLowerCase().includes(q) ||
            Boolean(entry.details?.toLowerCase().includes(q))
        );
    });
});

function isEntryExpanded(entry: OutputLogEntry): boolean {
    if (manualExpandedIds.has(entry.id)) {
        return true;
    }
    if (manualCollapsedIds.has(entry.id)) {
        return false;
    }
    return entry.level === 'error';
}

function toggleEntryDetails(entry: OutputLogEntry): void {
    const currentlyExpanded = isEntryExpanded(entry);
    const nextExpanded = new Set(manualExpandedIds);
    const nextCollapsed = new Set(manualCollapsedIds);
    if (currentlyExpanded) {
        nextExpanded.delete(entry.id);
        nextCollapsed.add(entry.id);
    } else {
        nextCollapsed.delete(entry.id);
        nextExpanded.add(entry.id);
    }
    manualExpandedIds = nextExpanded;
    manualCollapsedIds = nextCollapsed;
}

function handleClear(): void {
    channel.clear();
    manualExpandedIds = new Set();
    manualCollapsedIds = new Set();
}

function handleCopyVisible(): void {
    const text = filteredEntries.map((e) => e.rawText).join('\n');
    writeClipboardText(text)
        .then(() => {
            copiedFeedback = true;
            setTimeout(() => {
                copiedFeedback = false;
            }, 1800);
        })
        .catch(() => {});
}
</script>

<div class="output-pane" data-testid="output-pane">
    <header class="pane-header" data-testid="output-header">
        <div class="header-left">
            <span class="pane-title" data-testid="output-title">
                Output
                <span class="channel-subtitle">· {channel.name}</span>
            </span>
            <span class="count-badge" data-testid="output-entry-count" title="Visible log entries">
                {filteredEntries.length}{filteredEntries.length !== entries.length ? ` / ${entries.length}` : ''}
            </span>
        </div>

        <div class="header-controls">
            <div class="level-filter-group" role="group" aria-label="Filter by log level" data-testid="output-level-filter">
                <button
                    type="button"
                    class="level-pill"
                    class:active={levelFilter === 'all'}
                    data-testid="output-level-all"
                    onclick={() => {
                        levelFilter = 'all';
                    }}
                >
                    All
                </button>
                <button
                    type="button"
                    class="level-pill"
                    class:active={levelFilter === 'info'}
                    data-testid="output-level-info"
                    onclick={() => {
                        levelFilter = 'info';
                    }}
                >
                    Info+
                </button>
                <button
                    type="button"
                    class="level-pill level-pill-warn"
                    class:active={levelFilter === 'warn'}
                    data-testid="output-level-warn"
                    onclick={() => {
                        levelFilter = 'warn';
                    }}
                >
                    Warn{#if warnCount > 0} <span class="pill-count">{warnCount}</span>{/if}
                </button>
                <button
                    type="button"
                    class="level-pill level-pill-error"
                    class:active={levelFilter === 'error'}
                    data-testid="output-level-error"
                    onclick={() => {
                        levelFilter = 'error';
                    }}
                >
                    Errors{#if errorCount > 0} <span class="pill-count">{errorCount}</span>{/if}
                </button>
                <button
                    type="button"
                    class="level-pill"
                    class:active={levelFilter === 'debug'}
                    data-testid="output-level-debug"
                    onclick={() => {
                        levelFilter = 'debug';
                    }}
                >
                    Debug
                </button>
            </div>

            {#if availableSources.length > 1}
                <select
                    class="source-select"
                    bind:value={sourceFilter}
                    aria-label="Filter by source"
                    data-testid="output-source-select"
                >
                    <option value="all">All Sources</option>
                    {#each availableSources as src (src)}
                        <option value={src}>{src}</option>
                    {/each}
                </select>
            {/if}

            <div class="filter-input-wrapper">
                <i class="codicon codicon-filter filter-icon" aria-hidden="true"></i>
                <input
                    type="text"
                    class="filter-input"
                    data-testid="output-filter-input"
                    placeholder="Filter output..."
                    bind:value={filterQuery}
                />
                {#if filterQuery}
                    <button
                        type="button"
                        class="clear-filter-btn"
                        data-testid="output-filter-clear"
                        title="Clear filter"
                        aria-label="Clear filter"
                        onclick={() => {
                            filterQuery = '';
                        }}
                    >
                        <i class="codicon codicon-close" aria-hidden="true"></i>
                    </button>
                {/if}
            </div>

            <div class="toolbar-actions">
                <button
                    type="button"
                    class="icon-button"
                    class:toggled={wordWrap}
                    data-testid="output-wrap-toggle"
                    title={wordWrap ? 'Disable Word Wrap' : 'Enable Word Wrap'}
                    aria-label="Toggle Word Wrap"
                    aria-pressed={wordWrap}
                    onclick={() => {
                        wordWrap = !wordWrap;
                    }}
                >
                    <i class="codicon codicon-word-wrap" aria-hidden="true"></i>
                </button>
                <button
                    type="button"
                    class="icon-button"
                    class:toggled={autoScroll}
                    data-testid="output-autoscroll-toggle"
                    title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll paused'}
                    aria-label="Toggle Auto-scroll"
                    aria-pressed={autoScroll}
                    onclick={() => {
                        autoScroll = !autoScroll;
                    }}
                >
                    <i class="codicon codicon-arrow-down" aria-hidden="true"></i>
                </button>
                <button
                    type="button"
                    class="icon-button"
                    data-testid="output-copy"
                    title={copiedFeedback ? 'Copied!' : 'Copy Visible Output'}
                    aria-label="Copy Visible Output"
                    disabled={filteredEntries.length === 0}
                    onclick={handleCopyVisible}
                >
                    <i class={`codicon ${copiedFeedback ? 'codicon-check' : 'codicon-copy'}`} aria-hidden="true"></i>
                </button>
                <button
                    type="button"
                    class="icon-button"
                    data-testid="output-clear"
                    title="Clear Output"
                    aria-label="Clear Output"
                    disabled={entries.length === 0}
                    onclick={handleClear}
                >
                    <i class="codicon codicon-clear-all" aria-hidden="true"></i>
                </button>
                {#if onClose}
                    <button
                        type="button"
                        class="icon-button"
                        data-testid="output-close"
                        title="Close"
                        aria-label="Close"
                        onclick={() => onClose()}
                    >
                        <i class="codicon codicon-close" aria-hidden="true"></i>
                    </button>
                {/if}
            </div>
        </div>
    </header>

    <div
        class="output-log-list"
        class:word-wrap={wordWrap}
        data-testid="output-log-list"
        bind:this={logListEl}
    >
        {#if entries.length === 0}
            <div class="empty-state" data-testid="output-empty">
                <i class="codicon codicon-output large-icon" aria-hidden="true"></i>
                <p>No output messages recorded yet.</p>
            </div>
        {:else if filteredEntries.length === 0}
            <div class="empty-state" data-testid="output-no-matches">
                <i class="codicon codicon-search large-icon" aria-hidden="true"></i>
                <p>No log entries match the active filters.</p>
            </div>
        {:else}
            {#each filteredEntries as entry (entry.id)}
                {@const hasDetails = Boolean(entry.details)}
                {@const expanded = hasDetails && isEntryExpanded(entry)}
                {@const tokens = tokenizeLogText(entry.message)}
                <div
                    class={`log-row level-${entry.level}`}
                    class:has-details={hasDetails}
                    data-testid="output-log-row"
                    data-level={entry.level}
                >
                    <div
                        class="log-row-main"
                        role={hasDetails ? 'button' : undefined}
                        aria-expanded={hasDetails ? expanded : undefined}
                        onclick={() => {
                            if (hasDetails) {
                                toggleEntryDetails(entry);
                            }
                        }}
                        onkeydown={(e) => {
                            if (hasDetails && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault();
                                toggleEntryDetails(entry);
                            }
                        }}
                    >
                        {#if hasDetails}
                            <i
                                class={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} detail-chevron`}
                                aria-hidden="true"
                            ></i>
                        {:else}
                            <span class="detail-spacer" aria-hidden="true"></span>
                        {/if}

                        <span class="log-timestamp" data-testid="output-log-timestamp">{entry.formattedTime}</span>

                        <span class={`log-level-badge badge-${entry.level}`} data-testid="output-log-level">
                            {entry.level.toUpperCase()}
                        </span>

                        {#if entry.source}
                            <span class="log-source-badge" data-testid="output-log-source">
                                {#each splitHighlightSegments(entry.source, filterQuery) as seg}
                                    {#if seg.match}
                                        <mark class="filter-highlight">{seg.text}</mark>
                                    {:else}
                                        {seg.text}
                                    {/if}
                                {/each}
                            </span>
                        {/if}

                        {#if entry.durationMs !== undefined}
                            <span
                                class="log-duration-badge"
                                class:slow={entry.durationMs >= 500}
                                data-testid="output-log-duration"
                            >
                                {entry.durationMs.toFixed(0)}ms{entry.cached ? ' · cached' : ''}
                            </span>
                        {/if}

                        <span class="log-message" data-testid="output-log-message">
                            {#each tokens as token}
                                <span class={`tok tok-${token.kind}`}>
                                    {#each splitHighlightSegments(token.text, filterQuery) as seg}
                                        {#if seg.match}
                                            <mark class="filter-highlight">{seg.text}</mark>
                                        {:else}
                                            {seg.text}
                                        {/if}
                                    {/each}
                                </span>
                            {/each}
                        </span>
                    </div>

                    {#if hasDetails && expanded && entry.details}
                        <pre class="log-details" data-testid="output-log-details">{#each splitHighlightSegments(entry.details, filterQuery) as seg}{#if seg.match}<mark class="filter-highlight">{seg.text}</mark>{:else}{seg.text}{/if}{/each}</pre>
                    {/if}
                </div>
            {/each}
        {/if}
    </div>
</div>

<style>
.output-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    min-height: 0;
    background-color: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    overflow: hidden;
}

.pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 35px;
    padding: 0 12px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
    flex-shrink: 0;
    box-sizing: border-box;
    overflow-x: auto;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-shrink: 0;
}

.pane-title {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
}

.channel-subtitle {
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
}

.count-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 6px;
    border-radius: 9px;
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
    font-weight: 600;
}

.header-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

.level-filter-group {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 6px;
    padding: 2px;
}

.level-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 7px;
    height: 20px;
    cursor: pointer;
    white-space: nowrap;
}

.level-pill:hover {
    color: var(--vscode-foreground);
    background-color: var(--vscode-list-hoverBackground);
}

.level-pill.active {
    background-color: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    font-weight: 600;
}

.pill-count {
    font-size: 10px;
    padding: 0 4px;
    border-radius: 6px;
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
}

.source-select {
    height: 24px;
    padding: 0 6px;
    border-radius: 6px;
    background-color: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    font-family: inherit;
    font-size: 11px;
    outline: none;
}

.source-select:focus {
    border-color: var(--vscode-focusBorder);
}

.filter-input-wrapper {
    position: relative;
    display: inline-flex;
    align-items: center;
}

.filter-icon {
    position: absolute;
    left: 7px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    pointer-events: none;
}

.filter-input {
    height: 24px;
    width: 180px;
    padding: 0 22px 0 24px;
    border-radius: 6px;
    background-color: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    font-family: inherit;
    font-size: 12px;
    box-sizing: border-box;
    outline: none;
}

.filter-input:focus {
    border-color: var(--vscode-focusBorder);
}

.clear-filter-btn {
    position: absolute;
    right: 4px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    width: 16px;
    height: 16px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    cursor: pointer;
}

.clear-filter-btn:hover {
    color: var(--vscode-foreground);
    background-color: var(--vscode-list-hoverBackground);
}

.toolbar-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
}

.icon-button {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-icon-foreground);
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
}

.icon-button:hover:not(:disabled) {
    background-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
}

.icon-button.toggled {
    background-color: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
}

.icon-button:disabled {
    opacity: 0.4;
    cursor: default;
}

.output-log-list {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: auto;
    padding: 6px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.5;
}

.output-log-list.word-wrap {
    overflow-x: hidden;
}

.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 10px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family);
    user-select: none;
}

.large-icon {
    font-size: 36px;
    opacity: 0.6;
}

.log-row {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid transparent;
    padding: 2px 10px;
}

.log-row:hover {
    background-color: var(--vscode-list-hoverBackground);
}

.log-row.level-error {
    background-color: color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent);
    border-left: 2px solid var(--vscode-errorForeground);
}

.log-row.level-warn {
    background-color: color-mix(in srgb, var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)) 6%, transparent);
    border-left: 2px solid var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground));
}

.log-row-main {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
}

.log-row.has-details .log-row-main {
    cursor: pointer;
}

.detail-chevron {
    font-size: 12px;
    width: 14px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
    align-self: center;
}

.detail-spacer {
    width: 14px;
    flex-shrink: 0;
}

.log-timestamp {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    flex-shrink: 0;
    user-select: text;
}

.log-level-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.3px;
    flex-shrink: 0;
}

.badge-error {
    color: var(--vscode-errorForeground);
    background-color: color-mix(in srgb, var(--vscode-errorForeground) 16%, transparent);
}

.badge-warn {
    color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground));
    background-color: color-mix(in srgb, var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)) 16%, transparent);
}

.badge-info {
    color: var(--vscode-charts-blue, var(--vscode-focusBorder));
    background-color: color-mix(in srgb, var(--vscode-charts-blue, var(--vscode-focusBorder)) 15%, transparent);
}

.badge-debug,
.badge-trace {
    color: var(--vscode-descriptionForeground);
    background-color: color-mix(in srgb, var(--vscode-descriptionForeground) 14%, transparent);
}

.log-source-badge {
    color: var(--vscode-foreground);
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 0 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
}

.log-duration-badge {
    color: var(--vscode-charts-green, var(--vscode-descriptionForeground));
    background-color: color-mix(in srgb, var(--vscode-charts-green, var(--vscode-descriptionForeground)) 14%, transparent);
    padding: 0 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
}

.log-duration-badge.slow {
    color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground));
    background-color: color-mix(in srgb, var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)) 16%, transparent);
}

.log-message {
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre;
    user-select: text;
}

.output-log-list.word-wrap .log-message {
    white-space: pre-wrap;
    word-break: break-word;
}

.tok-url {
    color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
    text-decoration: underline;
}

.tok-string {
    color: var(--vscode-charts-orange, var(--vscode-descriptionForeground));
}

.tok-flag {
    color: var(--vscode-charts-blue, var(--vscode-focusBorder));
}

.tok-path {
    color: var(--vscode-charts-purple, var(--vscode-foreground));
}

.tok-duration {
    color: var(--vscode-charts-green, var(--vscode-descriptionForeground));
    font-weight: 600;
}

.tok-rev {
    color: var(--vscode-charts-blue, var(--vscode-focusBorder));
    font-weight: 600;
}

.tok-keyword-error {
    color: var(--vscode-errorForeground);
    font-weight: 600;
}

.tok-keyword-success {
    color: var(--vscode-charts-green, var(--vscode-foreground));
    font-weight: 600;
}

.filter-highlight {
    background-color: color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent);
    color: var(--vscode-foreground);
    border-radius: 2px;
    padding: 0 1px;
}

.log-details {
    margin: 4px 0 4px 20px;
    padding: 8px 10px;
    border-radius: 6px;
    background-color: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroupHeader-tabsBorder));
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
}
</style>
