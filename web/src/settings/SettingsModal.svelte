<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import type { HostConfig } from '../../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import type { WebHostEnvironment } from '../host/web-host-environment';
import { loadScopedSettings, saveScopedSetting } from './settings-helpers';
import { ALL_SETTINGS, filterSettings, getCategories, type SettingDefinition } from './settings-schema';

interface Props {
    hostSystem?: RemoteHostSystem | null;
    hostConfig?: HostConfig | null;
    webHostEnv?: WebHostEnvironment | null;
    onClose: () => void;
}

let { hostSystem, hostConfig, webHostEnv, onClose }: Props = $props();

const activeHostSystem = $derived(hostSystem ?? webHostEnv?.system);
const activeHostConfig = $derived(hostConfig ?? webHostEnv?.config);

type Scope = 'user' | 'workspace';

let activeScope: Scope = $state('user');
let searchQuery: string = $state('');
let selectedCategory: string = $state('All');
let userConfig: Record<string, unknown> = $state({});
let workspaceConfig: Record<string, unknown> = $state({});
let isLoading: boolean = $state(false);
let searchInputEl: HTMLInputElement | null = $state(null);

const categories = $derived(['All', ...getCategories(ALL_SETTINGS)]);
const filteredSettings = $derived(filterSettings(ALL_SETTINGS, searchQuery, selectedCategory));

async function loadConfigs(): Promise<void> {
    try {
        const [user, ws] = await Promise.all([
            loadScopedSettings(activeHostSystem, 'user'),
            loadScopedSettings(activeHostSystem, 'workspace'),
        ]);
        userConfig = user;
        workspaceConfig = ws;
    } catch (err) {
        console.error('[SettingsModal] Failed to load scoped configs:', err);
    } finally {
        isLoading = false;
    }
}

onMount(() => {
    loadConfigs();
    if (searchInputEl) {
        searchInputEl.focus();
    }

    const disposable = activeHostConfig?.onDidChangeConfiguration?.(() => {
        loadConfigs();
    });

    return () => {
        disposable?.dispose?.();
    };
});

function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
    }
}

function normalizeKey(key: string): string {
    return key.replace(/^jj-view\./, '');
}

function getValueInActiveScope(setting: SettingDefinition): unknown {
    const norm = normalizeKey(setting.key);
    const scopeData = activeScope === 'workspace' ? workspaceConfig : userConfig;

    if (scopeData[setting.key] !== undefined) {
        return scopeData[setting.key];
    }
    if (scopeData[norm] !== undefined) {
        return scopeData[norm];
    }
    if (scopeData[`jj-view.${norm}`] !== undefined) {
        return scopeData[`jj-view.${norm}`];
    }
    return undefined;
}

function getEffectiveValue(setting: SettingDefinition): unknown {
    const scopedVal = getValueInActiveScope(setting);
    if (scopedVal !== undefined) {
        return scopedVal;
    }
    // If viewing workspace scope, fall back to userConfig before effective config / default
    if (activeScope === 'workspace') {
        const norm = normalizeKey(setting.key);
        const userVal = userConfig[setting.key] ?? userConfig[norm] ?? userConfig[`jj-view.${norm}`];
        if (userVal !== undefined) {
            return userVal;
        }
    }
    // Fall back to effective config or schema default
    const effective = activeHostConfig?.get(setting.key, undefined);
    if (effective !== undefined) {
        return effective;
    }
    return setting.default;
}

function isModifiedInActiveScope(setting: SettingDefinition): boolean {
    return getValueInActiveScope(setting) !== undefined;
}

async function handleChange(setting: SettingDefinition, newValue: unknown): Promise<void> {
    await saveScopedSetting(activeHostSystem, activeHostConfig, setting.key, newValue, activeScope);
    await loadConfigs();
}

async function handleReset(setting: SettingDefinition): Promise<void> {
    await saveScopedSetting(activeHostSystem, activeHostConfig, setting.key, null, activeScope);
    await loadConfigs();
}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div
        class="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings-modal"
    >
        <!-- Modal Header -->
        <header class="modal-header">
            <div class="header-left">
                <i class="codicon codicon-settings-gear header-icon" aria-hidden="true"></i>
                <h2 id="settings-title" class="modal-title">Settings</h2>
            </div>

            <!-- Scope Segmented Button -->
            <div class="segmented-control" role="tablist" aria-label="Settings Scope">
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeScope === 'user'}
                    class="segment-btn scope-tab"
                    class:active={activeScope === 'user'}
                    data-testid="scope-tab-user"
                    onclick={() => (activeScope = 'user')}
                >
                    <i class="codicon codicon-account" aria-hidden="true"></i>
                    <span>User</span>
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeScope === 'workspace'}
                    class="segment-btn scope-tab"
                    class:active={activeScope === 'workspace'}
                    data-testid="scope-tab-workspace"
                    onclick={() => (activeScope = 'workspace')}
                >
                    <i class="codicon codicon-root-folder" aria-hidden="true"></i>
                    <span>Workspace</span>
                </button>
            </div>

            <!-- Search input -->
            <div class="search-container">
                <i class="codicon codicon-search search-icon" aria-hidden="true"></i>
                <input
                    bind:this={searchInputEl}
                    type="text"
                    class="search-input"
                    placeholder="Search settings..."
                    data-testid="settings-search-input"
                    bind:value={searchQuery}
                />
                {#if searchQuery}
                    <button
                        type="button"
                        class="clear-search-btn"
                        title="Clear search"
                        aria-label="Clear search"
                        onclick={() => (searchQuery = '')}
                    >
                        <i class="codicon codicon-close" aria-hidden="true"></i>
                    </button>
                {/if}
            </div>

            <!-- Close Button -->
            <button
                type="button"
                class="close-button"
                title="Close (Escape)"
                aria-label="Close"
                data-testid="settings-close-btn"
                onclick={onClose}
            >
                <i class="codicon codicon-close" aria-hidden="true"></i>
            </button>
        </header>

        <!-- Modal Body: Sidebar Categories + Settings List -->
        <div class="modal-body">
            <!-- Category Sidebar -->
            <nav class="category-sidebar" aria-label="Settings categories">
                {#each categories as category}
                    <button
                        type="button"
                        class="category-btn"
                        class:active={selectedCategory === category}
                        data-testid={`category-btn-${category.toLowerCase().replace(/\s+/g, '-')}`}
                        onclick={() => (selectedCategory = category)}
                    >
                        <span>{category}</span>
                    </button>
                {/each}
            </nav>

            <!-- Settings Content -->
            <main class="settings-content" data-testid="settings-content">
                {#if isLoading}
                    <div class="loading-state">
                        <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
                        <span>Loading settings...</span>
                    </div>
                {:else if filteredSettings.length === 0}
                    <div class="empty-state" data-testid="settings-empty-state">
                        <i class="codicon codicon-search" aria-hidden="true"></i>
                        <p>No settings match "{searchQuery}"</p>
                    </div>
                {:else}
                    <div class="settings-list">
                        {#each filteredSettings as setting (setting.key)}
                            {@const val = getEffectiveValue(setting)}
                            {@const isModified = isModifiedInActiveScope(setting)}
                            <div class="setting-item" data-testid={`setting-item-${setting.key}`}>
                                <div class="setting-header">
                                    <div class="setting-title-row">
                                        {#if isModified}
                                            <span class="modified-dot" title="Modified in this scope" aria-label="Modified"></span>
                                        {/if}
                                        <h3 class="setting-title">{setting.title}</h3>
                                        <code class="setting-key">{setting.key}</code>
                                    </div>

                                    {#if isModified}
                                        <button
                                            type="button"
                                            class="reset-btn"
                                            title="Reset to default in this scope"
                                            data-testid={`reset-btn-${setting.key}`}
                                            onclick={() => handleReset(setting)}
                                        >
                                            <i class="codicon codicon-discard" aria-hidden="true"></i>
                                            <span>Reset</span>
                                        </button>
                                    {/if}
                                </div>

                                <p class="setting-description">{setting.description}</p>

                                <div class="setting-control">
                                    {#if setting.enum && setting.enum.length > 0}
                                        <select
                                            class="setting-select"
                                            data-testid={`setting-control-${setting.key}`}
                                            value={String(val ?? setting.default)}
                                            onchange={(e) => {
                                                const target = e.currentTarget;
                                                const raw = target.value;
                                                if (setting.type === 'boolean') {
                                                    handleChange(setting, raw === 'true');
                                                } else if (setting.type === 'number') {
                                                    handleChange(setting, Number(raw));
                                                } else {
                                                    handleChange(setting, raw);
                                                }
                                            }}
                                        >
                                            {#each setting.enum as opt, idx}
                                                <option value={String(opt)}>
                                                    {opt} {setting.enumDescriptions?.[idx] ? `(${setting.enumDescriptions[idx]})` : ''}
                                                </option>
                                            {/each}
                                        </select>
                                    {:else if setting.type === 'boolean'}
                                        <label class="setting-toggle">
                                            <input
                                                type="checkbox"
                                                class="setting-checkbox"
                                                data-testid={`setting-control-${setting.key}`}
                                                checked={Boolean(val)}
                                                onchange={(e) => handleChange(setting, e.currentTarget.checked)}
                                            />
                                            <span class="toggle-label">{val ? 'Enabled' : 'Disabled'}</span>
                                        </label>
                                    {:else if setting.type === 'number'}
                                        <input
                                            type="number"
                                            class="setting-input setting-number"
                                            data-testid={`setting-control-${setting.key}`}
                                            value={Number(val ?? setting.default ?? 0)}
                                            onchange={(e) => handleChange(setting, Number(e.currentTarget.value))}
                                        />
                                    {:else}
                                        <input
                                            type="text"
                                            class="setting-input setting-text"
                                            data-testid={`setting-control-${setting.key}`}
                                            value={String(val ?? setting.default ?? '')}
                                            onchange={(e) => handleChange(setting, e.currentTarget.value)}
                                        />
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </main>
        </div>
    </div>
</div>

<style>
.modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}

.modal-dialog {
    background: var(--vscode-sideBar-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    width: 900px;
    max-width: 95vw;
    height: 640px;
    max-height: 90vh;
    border-radius: 8px;
    border: 1px solid var(--vscode-sideBar-border, #1d1d1d);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

/* Header */
.modal-header {
    height: 52px;
    min-height: 52px;
    border-bottom: 1px solid var(--vscode-sideBar-border, #1d1d1d);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    background: var(--vscode-sideBar-background, #171717);
}

.header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

.header-icon {
    font-size: 16px;
    color: var(--vscode-foreground, #d4d4d4);
}

.modal-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.2px;
}

.segmented-control {
    display: inline-flex;
    align-items: stretch;
    height: 28px;
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    border-radius: 6px;
    background: var(--vscode-input-background, #262626);
    overflow: hidden;
    box-sizing: border-box;
}

.segment-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    border: none;
    border-right: 1px solid var(--vscode-input-border, #2c2c2c);
    background: transparent;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
    white-space: nowrap;
    outline: none;
    user-select: none;
}

.segment-btn:last-child {
    border-right: none;
}

.segment-btn:hover:not(.active) {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.05));
    color: var(--vscode-foreground, #d4d4d4);
}

.segment-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #69b1ff);
    outline-offset: -1px;
}

.segment-btn.active {
    background: var(--vscode-button-background, #69b1ff);
    color: var(--vscode-button-foreground, #171717);
    font-weight: 600;
}

.search-container {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
}

.search-icon {
    position: absolute;
    left: 10px;
    color: var(--vscode-input-placeholderForeground, #525252);
    pointer-events: none;
    font-size: 14px;
}

.search-input {
    width: 100%;
    padding: 6px 30px 6px 32px;
    background: var(--vscode-input-background, #262626);
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    border-radius: 6px;
    color: var(--vscode-input-foreground, #d4d4d4);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s ease;
}

.search-input:focus {
    border-color: var(--vscode-focusBorder, #69b1ff);
}

.clear-search-btn {
    position: absolute;
    right: 8px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.clear-search-btn:hover {
    color: var(--vscode-foreground, #d4d4d4);
}

.close-button {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    cursor: pointer;
    padding: 6px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: all 0.15s ease;
}

.close-button:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
    color: var(--vscode-foreground, #d4d4d4);
}

/* Modal Body */
.modal-body {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
}

.category-sidebar {
    width: 190px;
    min-width: 190px;
    border-right: 1px solid var(--vscode-sideBar-border, #1d1d1d);
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    background: var(--vscode-sideBar-background, #171717);
}

.category-btn {
    display: flex;
    align-items: center;
    padding: 7px 12px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-sideBar-foreground, #d4d4d4);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s ease;
}

.category-btn:hover {
    background: var(--vscode-list-hoverBackground, #1f1f1f);
}

.category-btn.active {
    background: var(--vscode-list-activeSelectionBackground, #1f3e5e);
    color: var(--vscode-list-activeSelectionForeground, #d4d4d4);
    font-weight: 500;
}

.settings-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px 24px;
    background: var(--vscode-editor-background, #171717);
}

.settings-list {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.setting-item {
    border-bottom: 1px solid var(--vscode-widget-border, #1d1d1d);
    padding-bottom: 16px;
}

.setting-item:last-child {
    border-bottom: none;
}

.setting-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
}

.setting-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.modified-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-focusBorder, #69b1ff);
    display: inline-block;
}

.setting-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground, #d4d4d4);
}

.setting-key {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    background: var(--vscode-input-background, #262626);
    padding: 2px 6px;
    border-radius: 3px;
}

.reset-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    background: var(--vscode-button-secondaryBackground, #262626);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    color: var(--vscode-button-secondaryForeground, #d4d4d4);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    line-height: normal;
    transition: background-color 0.15s ease, color 0.15s ease;
}

.reset-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, #2c2c2c);
    color: var(--vscode-foreground, #d4d4d4);
}

.setting-description {
    margin: 0 0 10px 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    line-height: 1.4;
}

.setting-control {
    display: flex;
    align-items: center;
}

.setting-select,
.setting-input {
    background: var(--vscode-input-background, #262626);
    color: var(--vscode-input-foreground, #d4d4d4);
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.setting-select {
    min-width: 280px;
    max-width: 100%;
    cursor: pointer;
}

.setting-select:focus,
.setting-input:focus {
    border-color: var(--vscode-focusBorder, #69b1ff);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #69b1ff);
}

.setting-number {
    width: 120px;
}

.setting-text {
    width: 320px;
    max-width: 100%;
}

.setting-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
}

.setting-checkbox {
    appearance: none;
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    min-width: 16px;
    min-height: 16px;
    border: 1px solid var(--vscode-input-border, #2c2c2c);
    background: var(--vscode-input-background, #262626);
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    margin: 0;
    padding: 0;
    transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.setting-toggle:hover .setting-checkbox,
.setting-checkbox:hover {
    border-color: var(--vscode-focusBorder, #69b1ff);
}

.setting-checkbox:focus-visible {
    border-color: var(--vscode-focusBorder, #69b1ff);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, #69b1ff);
}

.setting-checkbox:checked {
    background: var(--vscode-focusBorder, #69b1ff);
    border-color: var(--vscode-focusBorder, #69b1ff);
}

.setting-checkbox:checked::after {
    content: '';
    display: block;
    width: 4px;
    height: 8px;
    border: solid var(--vscode-button-foreground, #171717);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
    margin-bottom: 2px;
}

.toggle-label {
    font-size: 13px;
    color: var(--vscode-foreground, #d4d4d4);
}

.loading-state,
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    gap: 12px;
    font-size: 14px;
}

.loading-state i,
.empty-state i {
    font-size: 28px;
}
</style>
