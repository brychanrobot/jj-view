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
    onCommit: (message: string) => void;
    onSetDescription: (message: string) => void;
    onValueChange?: (message: string) => void;
}

let {
    value = '',
    changeId,
    placeholder = 'Describe your changes... (Ctrl+Enter to commit, Ctrl+S to set description)',
    titleWidthRuler = 50,
    bodyWidthRuler = 72,
    onCommit,
    onSetDescription,
    onValueChange,
}: Props = $props();

// svelte-ignore state_referenced_locally
let description = $state(value);
// svelte-ignore state_referenced_locally
let previousValue = $state(value);
// svelte-ignore state_referenced_locally
let previousChangeId = $state(changeId);
let textareaEl: HTMLTextAreaElement | null = $state(null);

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
            onkeydown={handleKeyDown}
            oninput={handleInput}
            aria-label="Commit description"
        ></textarea>
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

.scm-textarea:focus {
    border-color: var(--vscode-focusBorder, #69b1ff);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #69b1ff);
}

.scm-textarea::placeholder {
    color: var(--vscode-input-placeholderForeground, #525252);
}
</style>
