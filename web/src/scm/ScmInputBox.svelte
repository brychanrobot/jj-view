<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onMount } from 'svelte';

interface Props {
    value?: string;
    changeId?: string;
    placeholder?: string;
    titleWidthRuler?: number;
    bodyWidthRuler?: number;
    isSidecarAvailable?: boolean;
    onCommit: (message: string) => void;
    onSetDescription: (message: string) => void;
    onValueChange?: (message: string) => void;
    onDraftWithAgent?: () => Promise<string | undefined>;
}

let {
    value = '',
    changeId,
    placeholder = 'Describe your changes... (Ctrl+Enter to commit, Ctrl+S to set description)',
    titleWidthRuler = 50,
    bodyWidthRuler = 72,
    isSidecarAvailable = false,
    onCommit,
    onSetDescription,
    onValueChange,
    onDraftWithAgent,
}: Props = $props();

// svelte-ignore state_referenced_locally
let description = $state(value);
// svelte-ignore state_referenced_locally
let previousValue = $state(value);
// svelte-ignore state_referenced_locally
let previousChangeId = $state(changeId);
let textareaEl: HTMLTextAreaElement | null = $state(null);
let isDrafting = $state(false);

$effect(() => {
    if (changeId !== previousChangeId) {
        previousChangeId = changeId;
        previousValue = value;
        description = value;
        setTimeout(() => handleInput(), 0);
        return;
    }
    if (value !== previousValue) {
        previousValue = value;
        description = value;
        setTimeout(() => handleInput(), 0);
    }
});

function triggerCommit(): void {
    const messageToCommit = description;
    onCommit(messageToCommit);
    description = '';
    previousValue = '';
    onValueChange?.('');
    if (textareaEl) {
        textareaEl.style.height = 'auto';
    }
}

function handleKeyDown(e: KeyboardEvent): void {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    if (modKey && e.key === 'Enter') {
        e.preventDefault();
        triggerCommit();
        return;
    }

    if (modKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        onSetDescription(description);
        return;
    }
}

function handleInput(): void {
    if (!textareaEl) {
        return;
    }
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${Math.max(68, textareaEl.scrollHeight)}px`;
    onValueChange?.(description);
}

async function handleDraftWithAgent(): Promise<void> {
    if (!onDraftWithAgent || isDrafting) {
        return;
    }
    isDrafting = true;
    try {
        const text = await onDraftWithAgent();
        if (text) {
            description = text;
            onValueChange?.(text);
            setTimeout(() => handleInput(), 0);
        }
    } finally {
        isDrafting = false;
    }
}

onMount(() => {
    handleInput();
});
</script>

<div class="scm-input-container" data-testid="scm-input-container">
    <div class="textarea-wrapper">
        <textarea
            bind:this={textareaEl}
            bind:value={description}
            class="scm-textarea"
            class:with-agent-btn={Boolean(onDraftWithAgent)}
            data-testid="scm-input-textarea"
            {placeholder}
            rows={3}
            onkeydown={handleKeyDown}
            oninput={handleInput}
            aria-label="Commit description"
        ></textarea>
        {#if Boolean(onDraftWithAgent)}
            <button
                type="button"
                class="agent-draft-button"
                class:loading={isDrafting}
                data-testid="agent-draft-button"
                title={isDrafting ? 'Drafting description with AI agent...' : 'Draft description with AI agent'}
                aria-label="Draft description with AI agent"
                onclick={handleDraftWithAgent}
                disabled={isDrafting}
            >
                <i class={isDrafting ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-sparkle'} aria-hidden="true"></i>
            </button>
        {/if}
    </div>
</div>

<style>
.scm-input-container {
    padding: 8px 12px 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background-color: var(--vscode-sideBar-background, #171717);
    box-sizing: border-box;
}

.textarea-wrapper {
    position: relative;
    width: 100%;
}

.scm-textarea {
    width: 100%;
    min-height: 68px;
    max-height: 240px;
    resize: vertical;
    box-sizing: border-box;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    background-color: var(--vscode-input-background, #262626);
    color: var(--vscode-input-foreground, #d4d4d4);
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    border-radius: 6px;
    padding: 8px 10px;
    line-height: 1.5;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.scm-textarea.with-agent-btn {
    padding-right: 32px;
}

.scm-textarea:focus {
    border-color: var(--vscode-focusBorder, #69b1ff);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #69b1ff);
}

.scm-textarea::placeholder {
    color: var(--vscode-input-placeholderForeground, #525252);
}

.agent-draft-button {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-icon-foreground, #c5c5c5);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
}

.agent-draft-button:hover:not(:disabled) {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
    color: var(--vscode-foreground, #ffffff);
}

.agent-draft-button:disabled {
    cursor: default;
    opacity: 0.7;
}

.agent-draft-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
}
</style>
