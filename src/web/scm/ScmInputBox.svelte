<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onMount } from 'svelte';

interface Props {
    value?: string;
    placeholder?: string;
    titleWidthRuler?: number;
    bodyWidthRuler?: number;
    onCommit: (message: string) => void;
    onSetDescription: (message: string) => void;
}

let {
    value = '',
    placeholder = 'Describe your changes... (Ctrl+Enter to commit, Ctrl+S to set description)',
    titleWidthRuler = 50,
    bodyWidthRuler = 72,
    onCommit,
    onSetDescription,
}: Props = $props();

// svelte-ignore state_referenced_locally
let description = $state(value);
let textareaEl: HTMLTextAreaElement | null = $state(null);
let isFocused = $state(false);

$effect(() => {
    if (!isFocused && value !== description) {
        description = value;
        setTimeout(() => handleInput(), 0);
    }
});

function handleKeyDown(e: KeyboardEvent): void {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    if (modKey && e.key === 'Enter') {
        e.preventDefault();
        onCommit(description);
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
            data-testid="scm-input-textarea"
            {placeholder}
            rows={3}
            onfocus={() => {
                isFocused = true;
            }}
            onblur={() => {
                isFocused = false;
            }}
            onkeydown={handleKeyDown}
            oninput={handleInput}
            aria-label="Commit description"
        ></textarea>
    </div>
    <div class="scm-input-actions">
        <button
            type="button"
            class="commit-button"
            data-testid="scm-commit-button"
            onclick={() => onCommit(description)}
            title="Commit changes (Ctrl+Enter)"
        >
            <i class="codicon codicon-check" aria-hidden="true"></i>
            <span>Commit</span>
        </button>
    </div>
</div>

<style>
.scm-input-container {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background-color: var(--vscode-sideBar-background, #1e1e1e);
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
    background-color: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 6px 8px;
    line-height: 1.4;
    outline: none;
}

.scm-textarea:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
}

.scm-textarea::placeholder {
    color: var(--vscode-input-placeholderForeground, #888888);
}

.scm-input-actions {
    display: flex;
    justify-content: flex-end;
}

.commit-button {
    background-color: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    border: none;
    border-radius: 2px;
    padding: 4px 12px;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-family: inherit;
    font-weight: 500;
}

.commit-button:hover {
    background-color: var(--vscode-button-hoverBackground, #1177bb);
}

.commit-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
}
</style>
