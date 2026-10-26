<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import { filterAndScoreQuickPickItems } from './fuzzy-score';
import type { QuickInputService } from './quick-input-service';
import type { QuickInputSession, QuickPickItem } from './quick-input-types';

interface Props {
    service: QuickInputService;
}

let { service }: Props = $props();

let sessionState = $state<QuickInputSession | null>(null);
const session = $derived(sessionState ?? service.activeSession);

let inputOverride = $state<string | null>(null);
const inputValue = $derived(
    inputOverride !== null ? inputOverride : session?.type === 'input-box' ? session.options.value || '' : '',
);
let selectedIndex = $state(0);
let validationError = $state<string | null>(null);
let inputEl = $state<HTMLInputElement | null>(null);
let listEl = $state<HTMLDivElement | null>(null);

let unsubscribe: (() => void) | null = null;
let lastSessionId: number | null = null;

function initSession(newSession: QuickInputSession | null): void {
    const isSameSessionUpdate =
        newSession !== null &&
        newSession.sessionId !== undefined &&
        lastSessionId !== null &&
        newSession.sessionId === lastSessionId;

    sessionState = newSession;
    lastSessionId = newSession?.sessionId ?? null;

    if (isSameSessionUpdate) {
        selectedIndex = 0;
        return;
    }

    inputOverride = null;
    if (newSession) {
        selectedIndex = 0;
        if (newSession.type === 'quick-pick' && newSession.options.activeItem) {
            const targetId = newSession.options.activeItem.id;
            const idx = (newSession.options.items || []).findIndex((it) => it.id === targetId);
            if (idx >= 0) {
                selectedIndex = idx;
            }
        }
        validationError = null;
        tick().then(() => {
            inputEl?.focus();
            if (newSession.type === 'input-box' && inputValue) {
                inputEl?.select();
            } else if (newSession.type === 'quick-pick') {
                scrollToSelected(selectedIndex);
            }
        });
    }
}

onMount(() => {
    initSession(service.activeSession);
    const disposable = service.onDidChangeSession((newSession) => {
        initSession(newSession);
    });
    unsubscribe = disposable.dispose;
});

onDestroy(() => {
    if (unsubscribe) {
        unsubscribe();
    }
});

const isQuickPick = $derived(session?.type === 'quick-pick' || session?.type === 'multi-quick-pick');

const filteredItems: QuickPickItem[] = $derived.by(() => {
    if (!session || !isQuickPick) {
        return [];
    }
    const options = session.options;
    const items = options.items || [];
    return filterAndScoreQuickPickItems(items, inputValue, {
        matchOnDescription: options.matchOnDescription,
        matchOnDetail: options.matchOnDetail,
        preserveOrder: options.preserveOrder,
    });
});

const hasAnyIcon = $derived(
    (session?.type === 'quick-pick' || session?.type === 'multi-quick-pick') &&
        (session.options.items || []).some((it) => Boolean(it.iconClass)),
);

$effect(() => {
    if (filteredItems.length > 0 && selectedIndex >= filteredItems.length) {
        selectedIndex = filteredItems.length - 1;
    }
});

$effect(() => {
    if (session?.type === 'quick-pick' && session.options.onDidChangeActive) {
        const activeItem = filteredItems[selectedIndex];
        session.options.onDidChangeActive(activeItem ? [activeItem] : []);
    }
});

async function handleInputChange(e: Event): Promise<void> {
    const target = e.currentTarget as HTMLInputElement | null;
    inputOverride = target ? target.value : '';
    selectedIndex = 0;
    if (session?.type === 'quick-pick' && session.options.onDidChangeValue) {
        session.options.onDidChangeValue(inputOverride || '');
    }
    if (session?.type === 'input-box' && session.options.validateInput) {
        try {
            const err = await session.options.validateInput(inputValue);
            validationError = err || null;
        } catch (e) {
            validationError = e instanceof Error ? e.message : 'Validation error';
        }
    } else {
        validationError = null;
    }
}

function scrollToSelected(index: number): void {
    if (!listEl) {
        return;
    }
    const elements = listEl.querySelectorAll<HTMLElement>('.quick-pick-item');
    const el = elements[index];
    if (el) {
        el.scrollIntoView({ block: 'nearest' });
    }
}

function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        e.preventDefault();
        service.cancel();
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filteredItems.length > 0) {
            selectedIndex = (selectedIndex + 1) % filteredItems.length;
            scrollToSelected(selectedIndex);
        }
        return;
    }

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filteredItems.length > 0) {
            selectedIndex = (selectedIndex - 1 + filteredItems.length) % filteredItems.length;
            scrollToSelected(selectedIndex);
        }
        return;
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        if (session?.type === 'input-box') {
            if (validationError) {
                return;
            }
            service.accept(inputValue);
            return;
        }

        if (session?.type === 'quick-pick') {
            const item = filteredItems[selectedIndex];
            if (item) {
                service.accept(item);
            } else if (session.options.acceptCustomValue && inputValue) {
                service.accept({ id: inputValue, label: inputValue, value: inputValue });
            }
            return;
        }
    }
}
</script>

{#if session}
    <!-- Backdrop -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="quick-input-backdrop"
        data-testid="quick-input-backdrop"
        onclick={() => service.cancel()}
    ></div>

    <!-- Quick Input Palette Container -->
    <div
        class="quick-input-widget"
        data-testid="quick-input-widget"
        role="dialog"
        aria-modal="true"
        aria-label={session.options.title || 'Quick Input'}
    >
        {#if session.options.title}
            <div class="quick-input-header">
                <span class="quick-input-title" data-testid="quick-input-title">{session.options.title}</span>
                <button
                    type="button"
                    class="quick-input-close"
                    title="Close (Escape)"
                    aria-label="Close"
                    data-testid="quick-input-close-btn"
                    onclick={() => service.cancel()}
                >
                    <i class="codicon codicon-close" aria-hidden="true"></i>
                </button>
            </div>
        {/if}

        {#if session.type === 'input-box' && session.options.contextAttachment}
            <div class="quick-input-context-attachment" data-testid="quick-input-context-attachment">
                <div class="quick-input-context-header">
                    <span class="quick-input-context-badge" data-testid="quick-input-context-badge">
                        <i class="codicon codicon-file-code" aria-hidden="true"></i>
                        <span>{session.options.contextAttachment.label}</span>
                    </span>
                    {#if session.options.contextAttachment.detail}
                        <span class="quick-input-context-detail" data-testid="quick-input-context-detail">
                            {session.options.contextAttachment.detail}
                        </span>
                    {/if}
                </div>
                <pre class="quick-input-context-snippet" data-testid="quick-input-context-snippet">{session.options.contextAttachment.snippet}</pre>
            </div>
        {/if}

        <div class="quick-input-input-wrapper">
            <input
                bind:this={inputEl}
                value={inputValue}
                type={session.type === 'input-box' && session.options.password ? 'password' : 'text'}
                class="quick-input-input"
                class:has-error={Boolean(validationError)}
                data-testid="quick-input-text-input"
                placeholder={session.options.placeHolder || (isQuickPick ? 'Type to search...' : '')}
                oninput={handleInputChange}
                onkeydown={handleKeyDown}
                aria-label="Quick Input Entry"
            />
        </div>

        {#if session.type === 'input-box' && session.options.prompt}
            <div class="quick-input-prompt" data-testid="quick-input-prompt">
                {session.options.prompt}
            </div>
        {/if}

        {#if validationError}
            <div class="quick-input-validation-message" data-testid="quick-input-validation-error">
                <i class="codicon codicon-error" aria-hidden="true"></i>
                <span>{validationError}</span>
            </div>
        {/if}

        {#if isQuickPick}
            <div
                bind:this={listEl}
                class="quick-pick-list"
                data-testid="quick-pick-list"
                role="listbox"
                aria-label="Items"
            >
                {#if filteredItems.length === 0}
                    <div class="no-items-message" data-testid="quick-pick-no-results">
                        No matching results
                    </div>
                {:else}
                    {#each filteredItems as item, idx (item.id)}
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <div
                            class="quick-pick-item"
                            class:active={idx === selectedIndex}
                            data-testid={`quick-pick-item-${item.id}`}
                            data-item-id={item.id}
                            role="option"
                            aria-selected={idx === selectedIndex}
                            tabindex="-1"
                            onclick={() => service.accept(item)}
                            onmouseenter={() => (selectedIndex = idx)}
                        >
                            {#if item.iconClass}
                                <i class={`item-icon ${item.iconClass}`} aria-hidden="true"></i>
                            {:else if hasAnyIcon}
                                <span class="item-icon item-icon-empty" aria-hidden="true"></span>
                            {/if}
                            <span class="item-label">{item.label}</span>
                            {#if item.description}
                                <span class="item-description">{item.description}</span>
                            {/if}
                            {#if item.detail}
                                <span class="item-detail">{item.detail}</span>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}
    </div>
{/if}

<style>
.quick-input-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    z-index: 9999;
}

.quick-input-widget {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    width: 500px;
    max-width: calc(100vw - 32px);
    z-index: 10000;
    background: var(--vscode-editor-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    border: 1px solid var(--vscode-widget-border, #2c2c2c);
    border-radius: 6px;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
}

.quick-input-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 35px;
    padding: 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    box-sizing: border-box;
    flex-shrink: 0;
}

.quick-input-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground, #d4d4d4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.quick-input-close {
    background: transparent;
    border: none;
    border-radius: 4px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-icon-foreground, #8a8a8a);
    cursor: pointer;
    padding: 0;
    transition: background-color 0.15s, color 0.15s;
}

.quick-input-close:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.quick-input-context-attachment {
    margin: 8px 10px 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.quick-input-context-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}

.quick-input-context-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.quick-input-context-detail {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    flex-shrink: 0;
}

.quick-input-context-snippet {
    margin: 0;
    padding: 6px 8px;
    max-height: 110px;
    overflow: auto;
    border-radius: 4px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    line-height: 1.4;
    white-space: pre;
}

.quick-input-input-wrapper {
    padding: 8px 10px;
    box-sizing: border-box;
}

.quick-input-input {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
    background: var(--vscode-input-background, #262626);
    color: var(--vscode-input-foreground, #d4d4d4);
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    border-radius: 6px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.quick-input-input:focus {
    border-color: var(--vscode-focusBorder, #69b1ff);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #69b1ff);
}

.quick-input-input.has-error {
    border-color: var(--vscode-inputValidation-errorBorder, #ff6762);
}

.quick-input-prompt {
    padding: 2px 12px 8px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    line-height: 1.4;
}

.quick-input-validation-message {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    margin: 0 10px 8px;
    border-radius: 4px;
    font-size: 12px;
    background: var(--vscode-inputValidation-errorBackground, rgba(255, 103, 98, 0.15));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #ff6762);
    color: var(--vscode-errorForeground, #ff6762);
}

.quick-pick-list {
    max-height: 380px;
    overflow-y: auto;
    padding: 4px 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-top: 1px solid var(--vscode-widget-border, #262626);
}

.quick-pick-item {
    display: flex;
    align-items: center;
    min-height: 28px;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    font-size: 13px;
    color: var(--vscode-foreground, #d4d4d4);
    gap: 8px;
}

.quick-pick-item:hover:not(.active) {
    background-color: var(--vscode-list-hoverBackground, #1f1f1f);
}

.quick-pick-item.active {
    background-color: var(--vscode-list-activeSelectionBackground, #1f3e5e);
    color: var(--vscode-list-activeSelectionForeground, #d4d4d4);
    font-weight: 500;
}

.item-icon {
    font-size: 15px;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--vscode-icon-foreground, #8a8a8a);
}

.item-icon-empty {
    visibility: hidden;
    pointer-events: none;
}

.quick-pick-item.active .item-icon {
    color: var(--vscode-foreground, #d4d4d4);
}

.item-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    flex-shrink: 0;
    max-width: 70%;
}

.item-description {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 8px;
    flex-shrink: 1;
    min-width: 0;
}

.quick-pick-item.active .item-description {
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    opacity: 0.85;
}

.item-detail {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--vscode-badge-background, var(--vscode-input-background));
    color: var(--vscode-badge-foreground, var(--vscode-descriptionForeground));
    flex-shrink: 0;
    white-space: nowrap;
}

.item-label + .item-detail {
    margin-left: auto;
}

.no-items-message {
    padding: 16px 12px;
    text-align: center;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
}
</style>
