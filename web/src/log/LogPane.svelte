<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import LogApp from '../../../src/core/webview/log/LogApp.svelte';
import { initBridge } from '../../../src/core/webview/transport/bridge.svelte';
import type { WebviewTransport } from '../../../src/core/webview/transport/types';
import { ContextKeyService, type IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItem } from '../menu/menu-types';

interface Props {
    transport: WebviewTransport;
    menuRegistry?: MenuRegistry;
    rootContext?: IContextKeyService;
    onAction?: (command: string, payload?: unknown) => void;
    /** Whether only the header is shown. */
    collapsed?: boolean;
    /** When provided, the header becomes a collapse toggle. */
    onToggleCollapsed?: () => void;
    /** Reports header + full graph height whenever the content changes size. */
    onPreferredHeightChange?: (height: number) => void;
}

let {
    transport,
    menuRegistry,
    rootContext,
    onAction,
    collapsed = false,
    onToggleCollapsed,
    onPreferredHeightChange,
}: Props = $props();

// svelte-ignore state_referenced_locally
initBridge(transport);

let version = $state(0);
let logContext = $state<IContextKeyService | undefined>();
let headerEl: HTMLElement | null = $state(null);
let logContentEl: HTMLElement | null = $state(null);

$effect(() => {
    const parent = rootContext ?? new ContextKeyService();
    const scoped = parent.createScoped({ view: 'jj-view.logView' });
    logContext = scoped;
    const disposable = scoped.onDidChangeContext(() => {
        version++;
    });
    return () => {
        disposable.dispose();
    };
});

// The scroll container stretches to fill whatever height it is given, so its
// own size says nothing about the content. Measure the graph element inside
// it instead; it is created only after the first load, hence the mutation
// observer to find (and re-find) it.
$effect(() => {
    const contentEl = logContentEl;
    const report = onPreferredHeightChange;
    if (!contentEl || !report) {
        return;
    }
    let observed: HTMLElement | null = null;

    const measure = (): void => {
        report((headerEl?.offsetHeight ?? 35) + (observed?.offsetHeight ?? 0));
    };

    const resizeObserver = new ResizeObserver(measure);

    const findContent = (): HTMLElement | null => {
        const el = contentEl.querySelector('.scroll-container > *') ?? contentEl.firstElementChild;
        return el instanceof HTMLElement ? el : null;
    };

    const sync = (): void => {
        const next = findContent();
        if (next === observed) {
            return;
        }
        if (observed) {
            resizeObserver.unobserve(observed);
        }
        observed = next;
        if (!next) {
            measure();
            return;
        }
        // ResizeObserver reports the initial size on observe().
        resizeObserver.observe(next);
    };

    const mutationObserver = new MutationObserver(sync);
    mutationObserver.observe(contentEl, { childList: true, subtree: true });
    sync();
    return () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
    };
});

const actions: ResolvedMenuItem[] = $derived.by(() => {
    if (version < 0 || !menuRegistry || !logContext) {
        return [];
    }
    return menuRegistry.getInlineActions('view/title', logContext);
});

function handleHeaderClick(e: MouseEvent): void {
    if (!onToggleCollapsed) {
        return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.log-toolbar')) {
        return;
    }
    onToggleCollapsed();
}
</script>

<div class="log-pane" data-testid="log-pane" data-collapsed={collapsed}>
    <!-- Clicking anywhere on the header toggles, like VS Code view headers; the
         twistie button inside carries the keyboard/ARIA affordance. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <header
        class="log-header"
        class:collapsible={Boolean(onToggleCollapsed)}
        data-testid="log-header"
        bind:this={headerEl}
        onclick={handleHeaderClick}
    >
        {#if onToggleCollapsed}
            <button
                type="button"
                class="log-title-button"
                data-testid="log-collapse-toggle"
                aria-expanded={!collapsed}
                aria-label={collapsed ? 'Expand log' : 'Collapse log'}
            >
                <i class={`codicon ${collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}`} aria-hidden="true"
                ></i>
                <span class="log-title">JJ LOG</span>
            </button>
        {:else}
            <span class="log-title">JJ LOG</span>
        {/if}
        <div class="log-toolbar" role="toolbar" aria-label="Log Actions">
            {#each actions as action (action.command)}
                <button
                    type="button"
                    class="icon-button toolbar-button"
                    data-testid={`log-title-action-${action.command}`}
                    title={action.title}
                    aria-label={action.title}
                    onclick={() => onAction?.(action.command)}
                >
                    {#if action.iconClass}
                        <i class={action.iconClass} aria-hidden="true"></i>
                    {:else}
                        <span>{action.title}</span>
                    {/if}
                </button>
            {/each}
        </div>
    </header>

    <div class="log-content" data-testid="log-content" bind:this={logContentEl}>
        <LogApp />
    </div>
</div>

<style>
.log-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    min-height: 0;
    background-color: var(--vscode-sideBar-background, #171717);
    color: var(--vscode-foreground, #d4d4d4);
    overflow: hidden;
}

.log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 35px;
    padding: 0 16px;
    background-color: var(--vscode-editorGroupHeader-tabsBackground, #171717);
    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    border-top: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1d1d1d);
    user-select: none;
    flex-shrink: 0;
    box-sizing: border-box;
}

.log-header.collapsible {
    cursor: pointer;
    padding-left: 8px;
}

.log-title-button {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.log-title-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
    border-radius: 4px;
}

.log-title-button .codicon {
    font-size: 16px;
    color: var(--vscode-icon-foreground, #8a8a8a);
}

.log-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.log-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
}

.toolbar-button {
    background: transparent;
    color: var(--vscode-icon-foreground, #8a8a8a);
    border: none;
    border-radius: 4px;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: background-color 0.15s, color 0.15s;
}

.toolbar-button:hover {
    background-color: var(--vscode-toolbar-hoverBackground, rgba(31, 62, 94, 0.45));
    color: var(--vscode-foreground);
}

.log-content {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
}

:global(.log-content > .app-container) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    flex: 1 1 0;
    overflow: hidden;
}

:global(.log-content .scroll-container) {
    flex: 1 1 0 !important;
    height: 100% !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
}

:global(.log-content .commit-id) {
    font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace) !important;
    font-size: 12px !important;
}

:global(.log-content .commit-desc) {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #d4d4d4);
}
</style>
