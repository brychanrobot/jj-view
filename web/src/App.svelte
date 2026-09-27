<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import path from 'pathe';
import { onMount } from 'svelte';
import { CommitDetailsController } from '../../src/core/controllers/commit-details-controller';
import type { HostDiffTab, HostOpenOptions } from '../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import type { JjEditFsService } from '../../src/core/jj-edit-fs-service';
import type { JjStatusEntry } from '../../src/core/jj-types';
import type { JjViewFsService } from '../../src/core/jj-view-fs-service';
import type { ScmModel, ScmSnapshot } from '../../src/core/scm-model';
import {
    createJjResourceState,
    type JjResourceState,
    type ResourceCommand,
    type ResourceDecorations,
} from '../../src/core/scm-resource-state';
import { encodeJjViewQuery, isWorkingCopyRevision, Uri } from '../../src/core/uri-utils';
import type { WebviewTransport } from '../../src/core/webview/transport/types';
import { NO_OP_LOGGER } from '../../src/utils/output-channel';
import { createInMemoryBridge, type InMemoryBridge } from './bridge/in-memory-bridge';
import CommitDetailsView from './details/CommitDetailsView.svelte';
import { applyAppTheme, loadTheme } from './diff/highlighter-setup';
import PierreDiffViewer from './diff/PierreDiffViewer.svelte';
import PierreMultiDiffViewer from './diff/PierreMultiDiffViewer.svelte';
import type { WebHostEnvironment } from './host/web-host-environment';
import AppLayout from './layout/AppLayout.svelte';
import LogPane from './log/LogPane.svelte';
import ContextMenu from './menu/ContextMenu.svelte';
import { ContextKeyService } from './menu/context-key-service';
import { extractVsCodeContext } from './menu/context-menu-utils';
import { DEFAULT_PACKAGE_JSON_CONTRIBUTES } from './menu/default-menus';
import { MenuRegistry } from './menu/menu-registry';
import type { ResolvedMenuItemGroup } from './menu/menu-types';
import { WhenEvaluator } from './menu/when-evaluator';
import NotificationContainer from './notifications/NotificationContainer.svelte';
import { NotificationService } from './notifications/notification-service';
import QuickInput from './quick-input/QuickInput.svelte';
import { type CommandPaletteEntry, QuickInputService } from './quick-input/quick-input-service';
import ScmPane from './scm/ScmPane.svelte';
import SettingsModal from './settings/SettingsModal.svelte';
import { AVAILABLE_THEMES, THEME_DESCRIPTIONS } from './settings/settings-schema';
import StatusBar from './status/StatusBar.svelte';
import { StatusBarService } from './status/status-bar-service';
import TabBar from './tabs/TabBar.svelte';
import {
    getTabId,
    type MultiDiffFileEntry,
    type TabEntry,
    type TabReorderPosition,
    type TabViewData,
} from './tabs/tab-types';

interface Props {
    host?: RemoteHostSystem;
    webHostEnv?: WebHostEnvironment;
    scmModel?: ScmModel;
    initialSnapshot?: ScmSnapshot;
    workspaceRoot?: string;
    viewFs?: JjViewFsService;
    editFs?: JjEditFsService;
    logTransport?: WebviewTransport;
    quickInputService?: QuickInputService;
    notificationService?: NotificationService;
    statusBarService?: StatusBarService;
}

let {
    host,
    webHostEnv,
    scmModel,
    initialSnapshot,
    workspaceRoot = '',
    viewFs,
    editFs,
    logTransport,
    quickInputService,
    notificationService,
    statusBarService,
}: Props = $props();

const fallbackQuickInput = new QuickInputService();
const activeQuickInput = $derived(quickInputService ?? webHostEnv?.quickInput ?? fallbackQuickInput);

const fallbackNotifications = new NotificationService();
const activeNotifications = $derived(notificationService ?? webHostEnv?.notifications ?? fallbackNotifications);

const fallbackStatusBar = new StatusBarService();
const activeStatusBar = $derived(statusBarService ?? webHostEnv?.statusBar ?? fallbackStatusBar);

const menuRegistry = new MenuRegistry();
const rootContext = new ContextKeyService();

// svelte-ignore state_referenced_locally
let currentSnapshot: ScmSnapshot | undefined = $state(initialSnapshot ?? scmModel?.snapshot);
let tabs = $state<TabEntry[]>([]);
let activeTabId = $state<string | undefined>();
let activeTabSelection = $state<{ startLine: number; endLine: number }[] | undefined>(undefined);
let isSettingsOpen = $state(false);
let activeTheme = $state('pierre-dark-soft');

const activeTab = $derived(tabs.find((t) => t.id === activeTabId));

$effect(() => {
    const uri =
        activeTab?.view.type === 'diff'
            ? (activeTab.view.rightUri ?? activeTab.view.leftUri)
            : activeTab?.view.type === 'file'
              ? activeTab.view.uri
              : undefined;
    activeTabSelection = undefined;
    webHostEnv?.documents.notifyActiveDocumentChanged(uri);
});

$effect(() => {
    if (currentSnapshot?.currentEntry) {
        activeStatusBar.setWorkingCopy({
            changeId: currentSnapshot.currentEntry.change_id,
            bookmark: currentSnapshot.currentEntry.bookmarks?.[0]?.name,
        });
    }
});

$effect(() => {
    if (host) {
        activeStatusBar.setConnectionStatus('connected');
    }
});

function openCommandPalette(): void {
    const rawCommands = DEFAULT_PACKAGE_JSON_CONTRIBUTES.commands || [];
    const paletteRules = DEFAULT_PACKAGE_JSON_CONTRIBUTES.menus?.commandPalette || [];

    // Map rules by command
    const ruleByCommand = new Map<string, (typeof paletteRules)[number]>();
    for (const rule of paletteRules) {
        ruleByCommand.set(rule.command, rule);
    }

    const commands: CommandPaletteEntry[] = [];
    const seenIds = new Set<string>();

    for (const cmd of rawCommands) {
        // Check omission rules from package.json commandPalette menu
        const rule = ruleByCommand.get(cmd.command);
        if (rule) {
            if (rule.when === 'false') {
                continue;
            }
            if (rule.when && !WhenEvaluator.evaluate(rule.when, rootContext)) {
                continue;
            }
        }

        seenIds.add(cmd.command);
        let iconClass: string | undefined;
        if (cmd.icon) {
            const iconStr = typeof cmd.icon === 'string' ? cmd.icon : cmd.icon.dark || cmd.icon.light;
            if (iconStr) {
                const match = /^\$\((.*?)\)$/.exec(iconStr);
                iconClass = match ? `codicon codicon-${match[1]}` : undefined;
            }
        }
        commands.push({
            id: cmd.command,
            title: cmd.title,
            category: cmd.category,
            iconClass,
        });
    }

    const builtIns: CommandPaletteEntry[] = [
        {
            id: 'workbench.action.openSettings',
            title: 'Open Settings',
            category: 'Preferences',
            iconClass: 'codicon codicon-settings-gear',
        },
        {
            id: 'workbench.action.selectTheme',
            title: 'Color Theme',
            category: 'Preferences',
            iconClass: 'codicon codicon-color-mode',
        },
    ];

    for (const b of builtIns) {
        if (!seenIds.has(b.id)) {
            seenIds.add(b.id);
            commands.push(b);
        }
    }

    void activeQuickInput.openCommandPalette(commands, async (cmdId) => {
        if (cmdId === 'workbench.action.selectTheme') {
            await openThemePicker();
            return;
        }
        if (webHostEnv) {
            await webHostEnv.commands.executeCommand(cmdId);
        }
    });
}

let themeRequestId = 0;

async function applyTheme(themeName: string): Promise<void> {
    const requestId = ++themeRequestId;
    activeTheme = themeName;
    try {
        const theme = await loadTheme(themeName);
        if (requestId !== themeRequestId) {
            return;
        }
        applyAppTheme(theme);
    } catch (err) {
        console.error(`Failed to load theme "${themeName}":`, err);
    }
}

async function openThemePicker(): Promise<void> {
    const initialTheme = activeTheme;
    const items = AVAILABLE_THEMES.map((themeId, idx) => ({
        id: themeId,
        label: themeId,
        description: THEME_DESCRIPTIONS[idx] ?? '',
        iconClass: themeId === initialTheme ? 'codicon codicon-check' : undefined,
    }));
    const activeItem = items.find((it) => it.id === initialTheme);

    const selected = await activeQuickInput.showQuickPick(items, {
        title: 'Select Color Theme',
        matchOnDescription: true,
        activeItem,
        onDidChangeActive: async (activeItems) => {
            const current = activeItems[0];
            if (current) {
                await applyTheme(current.label);
            }
        },
    });

    if (selected) {
        if (webHostEnv) {
            await webHostEnv.config.update('appearance.theme', selected.label);
        } else {
            await applyTheme(selected.label);
        }
    } else {
        await applyTheme(initialTheme);
    }
}

function handleWindowKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        isSettingsOpen = true;
        return;
    }

    if (((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) || e.key === 'F1') {
        e.preventDefault();
        openCommandPalette();
        return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        if (activeTabId) {
            e.preventDefault();
            closeTabById(activeTabId);
            return;
        }
    }
}

let commitDetailsBridge: InMemoryBridge | null = $state(null);
let commitDetailsController: CommitDetailsController | null = null;

function openOrActivateTab(view: TabViewData, options?: HostOpenOptions): void {
    const tabId = getTabId(view);
    const existingIndex = tabs.findIndex((t) => t.id === tabId);

    if (existingIndex >= 0) {
        activeTabId = tabId;
        const existingTab = tabs[existingIndex];
        if (existingTab && view.type === 'diff' && existingTab.view.type === 'diff') {
            if (!existingTab.isDirty) {
                existingTab.view.originalContent = view.originalContent;
                existingTab.view.modifiedContent = view.modifiedContent;
            }
        }
        if (existingTab && view.type === 'multi-diff' && existingTab.view.type === 'multi-diff') {
            existingTab.view.files = view.files;
        }
        if (options?.preview === false && existingTab.preview) {
            existingTab.preview = false;
        }
        return;
    }

    let title = 'Document';
    let tooltip: string | undefined;
    let iconClass: string | undefined;

    if (view.type === 'diff') {
        title = view.title;
        tooltip = view.rightUri?.fsPath || view.leftUri?.fsPath || view.title;
        iconClass = 'codicon codicon-diff';
    } else if (view.type === 'multi-diff') {
        title = view.title;
        tooltip = view.title;
        iconClass = 'codicon codicon-diff-multiple';
    } else if (view.type === 'commit-details') {
        title = view.title || `Commit ${view.changeId.slice(0, 8)}`;
        tooltip = `Commit ${view.changeId}`;
        iconClass = 'codicon codicon-git-commit';
    } else if (view.type === 'file') {
        title = view.title;
        tooltip = view.uri.fsPath;
        iconClass = 'codicon codicon-file';
    }

    const isPreview = options?.preview ?? false;
    const newTab: TabEntry = {
        id: tabId,
        title,
        tooltip,
        iconClass,
        preview: isPreview,
        isDirty: false,
        view,
    };

    if (isPreview) {
        const previewIndex = tabs.findIndex((t) => t.preview && !t.isDirty);
        if (previewIndex >= 0) {
            tabs[previewIndex] = newTab;
            activeTabId = newTab.id;
            return;
        }
    }

    tabs.push(newTab);
    activeTabId = newTab.id;
}

function closeTabById(tabId: string): void {
    const index = tabs.findIndex((t) => t.id === tabId);
    if (index === -1) {
        return;
    }

    tabs.splice(index, 1);

    if (activeTabId === tabId) {
        if (tabs.length === 0) {
            activeTabId = undefined;
        } else {
            const nextIndex = Math.min(index, tabs.length - 1);
            activeTabId = tabs[nextIndex].id;
        }
    }
}

function closeTabByUri(uri: Uri): void {
    const uriStr = uri.toString();
    const toClose = tabs.filter((t) => {
        if (t.view.type === 'diff') {
            return t.view.rightUri?.toString() === uriStr || t.view.leftUri?.toString() === uriStr;
        }
        if (t.view.type === 'file') {
            return t.view.uri.toString() === uriStr;
        }
        return false;
    });
    for (const t of toClose) {
        closeTabById(t.id);
    }
}

function pinTab(tabId: string): void {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
        tab.preview = false;
    }
}

function handleReorderTabs(sourceTabId: string, targetTabId: string, position: TabReorderPosition): void {
    const sourceIndex = tabs.findIndex((t) => t.id === sourceTabId);
    const targetIndex = tabs.findIndex((t) => t.id === targetTabId);
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
        return;
    }

    const [movedTab] = tabs.splice(sourceIndex, 1);
    const newTargetIndex = tabs.findIndex((t) => t.id === targetTabId);
    const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
    tabs.splice(insertIndex, 0, movedTab);
}

async function resolveUriContent(uri?: Uri): Promise<string> {
    if (!uri) {
        return '';
    }
    if (uri.scheme === 'file' && host) {
        return await host.fs.readTextFile(uri.fsPath);
    }
    if (uri.scheme === 'jj-view' && viewFs) {
        const bytes = await viewFs.readFile(uri);
        return new TextDecoder().decode(bytes);
    }
    if (uri.scheme === 'jj-edit' && editFs) {
        const bytes = await editFs.readFile(uri);
        return new TextDecoder().decode(bytes);
    }
    return '';
}

async function loadDiffFromUris(
    leftUri?: Uri,
    rightUri?: Uri,
    title?: string,
    resourceState?: JjResourceState,
    options?: HostOpenOptions,
): Promise<void> {
    const diffTitle = title || rightUri?.fsPath || leftUri?.fsPath || 'Diff';
    openOrActivateTab(
        {
            type: 'diff',
            leftUri,
            rightUri,
            title: diffTitle,
            resourceState,
            originalContent: '',
            modifiedContent: '',
        },
        options,
    );

    try {
        const [leftText, rightText] = await Promise.all([resolveUriContent(leftUri), resolveUriContent(rightUri)]);
        const tabId = getTabId({
            type: 'diff',
            leftUri,
            rightUri,
            title: diffTitle,
        });
        const targetTab = tabs.find((t) => t.id === tabId);
        if (targetTab && targetTab.view.type === 'diff') {
            targetTab.view.originalContent = leftText;
            if (!targetTab.isDirty) {
                targetTab.view.modifiedContent = rightText;
            }
        }
    } catch (err) {
        console.error('Failed to load file contents for diff:', err);
    }
}

async function loadDiffContents(state: JjResourceState, options?: HostOpenOptions): Promise<void> {
    await loadDiffFromUris(state.leftUri, state.rightUri, state.diffTitle || state.resourceUri.fsPath, state, options);
}

async function handleSaveFile(newContent: string): Promise<void> {
    if (!activeTab || activeTab.view.type !== 'diff' || !activeTab.view.rightUri) {
        return;
    }
    const rightUri = activeTab.view.rightUri;
    if (rightUri.scheme === 'jj-edit' && editFs) {
        await editFs.writeFile(rightUri, new TextEncoder().encode(newContent));
    } else if (host) {
        await host.fs.writeTextFile(rightUri.fsPath, newContent);
    }
    activeTab.view.modifiedContent = newContent;
    activeTab.isDirty = false;
    webHostEnv?.documents.notifyDidSaveDocument(rightUri);
    if (scmModel) {
        await scmModel.refresh({ reason: 'save-diff' });
    }
}

async function handleDiscardFile(): Promise<void> {
    if (!activeTab || activeTab.view.type !== 'diff' || !activeTab.view.resourceState) {
        return;
    }
    const state = activeTab.view.resourceState;
    await handleAction('jj-view.restore', state);
    if (scmModel) {
        await scmModel.refresh({ reason: 'discard-file' });
    }
    closeTabById(activeTab.id);
}

async function handleResolveConflict(): Promise<void> {
    if (!activeTab || activeTab.view.type !== 'diff' || !activeTab.view.resourceState) {
        return;
    }
    if (scmModel) {
        await scmModel.refresh({ reason: 'resolve-conflict' });
    }
    await loadDiffContents(activeTab.view.resourceState, { preview: false });
}

async function handleSquashSelection(ranges: { startLine: number; endLine: number }[]): Promise<void> {
    if (!activeTab || activeTab.view.type !== 'diff' || !activeTab.view.rightUri) {
        return;
    }
    if (activeTab.isDirty && webHostEnv?.documents) {
        await webHostEnv.documents.saveIfDirty(activeTab.view.rightUri);
    }
    const uri = activeTab.view.rightUri;
    const revision = activeTab.view.resourceState?.revision ?? '@';
    await (webHostEnv?.commands ?? host?.commands)?.executeCommand('jj-view.squashSelectionIntoParent', {
        uri,
        ranges,
        revision,
    });
}

$effect(() => {
    if (!scmModel) {
        return;
    }
    const disposable = scmModel.onDidChangeSnapshot((snapshot) => {
        currentSnapshot = snapshot;
    });
    return () => {
        disposable.dispose();
    };
});

$effect(() => {
    if (activeTab?.view.type === 'commit-details' && scmModel && webHostEnv) {
        const changeId = activeTab.view.changeId;
        const bridge = createInMemoryBridge(async (msg) => {
            if (commitDetailsController) {
                await commitDetailsController.handleMessage(msg);
            }
        });
        commitDetailsBridge = bridge;
        commitDetailsController = new CommitDetailsController(changeId, scmModel.repo, webHostEnv, {
            logger: NO_OP_LOGGER,
            openDiff: async ({ file, changeId: cId, isWorkingCopy }) => {
                const repo = scmModel?.repo;
                if (!repo) {
                    return;
                }
                const leftUri = Uri.from({
                    scheme: 'jj-view',
                    path: file.path.startsWith('/') ? file.path : `/${file.path}`,
                    fragment: encodeJjViewQuery({ mode: 'diff', root: workspaceRoot, base: cId, side: 'left' }),
                });
                const rightUri = isWorkingCopy
                    ? Uri.file(path.join(workspaceRoot, file.path))
                    : Uri.from({
                          scheme: 'jj-view',
                          path: file.path.startsWith('/') ? file.path : `/${file.path}`,
                          fragment: encodeJjViewQuery({ mode: 'diff', root: workspaceRoot, base: cId, side: 'right' }),
                      });
                const matchingState = createJjResourceState(file, cId, workspaceRoot, {
                    editable: isWorkingCopy,
                    workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
                });
                await loadDiffFromUris(leftUri, rightUri, `${file.path} (${cId.slice(0, 8)})`, matchingState, {
                    preview: true,
                });
            },
        });
        const messengerSub = bridge.messenger ? commitDetailsController.addMessenger(bridge.messenger) : undefined;
        void commitDetailsController.load();
        return () => {
            messengerSub?.dispose();
            commitDetailsController?.dispose();
            commitDetailsController = null;
            commitDetailsBridge = null;
        };
    }
});

interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    groups: readonly ResolvedMenuItemGroup[];
    payload?: unknown;
}

let contextMenuState = $state<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    groups: [],
    payload: undefined,
});

function closeContextMenu(): void {
    contextMenuState = {
        visible: false,
        x: 0,
        y: 0,
        groups: [],
        payload: undefined,
    };
}

function handleWindowContextMenu(e: MouseEvent): void {
    const target = e.target as Element | null;
    const context = extractVsCodeContext(target);
    if (!context) {
        if (contextMenuState.visible) {
            closeContextMenu();
        }
        return;
    }

    if (context.preventDefaultContextMenuItems) {
        e.preventDefault();
    }

    const menuId = typeof context.menuId === 'string' ? context.menuId : 'webview/context';
    const scopedCtx = rootContext.createScoped(context);
    const groups = menuRegistry.getContextActions(menuId, scopedCtx);

    if (groups.length === 0) {
        if (contextMenuState.visible) {
            closeContextMenu();
        }
        return;
    }

    e.preventDefault();
    e.stopPropagation();
    contextMenuState = {
        visible: true,
        x: e.clientX,
        y: e.clientY,
        groups,
        payload: context,
    };
}

function reviveResourceState(raw: Record<string, unknown>): JjResourceState {
    const rawUri = raw.resourceUri as Parameters<typeof Uri.revive>[0] | undefined;
    const resourceUri = rawUri ? Uri.revive(rawUri) : Uri.file('');
    const rawLeft = raw.leftUri as Parameters<typeof Uri.revive>[0] | undefined;
    const leftUri = rawLeft ? Uri.revive(rawLeft) : undefined;
    const rawRight = raw.rightUri as Parameters<typeof Uri.revive>[0] | undefined;
    const rightUri = rawRight ? Uri.revive(rawRight) : undefined;
    const command = raw.command as ResourceCommand | undefined;
    const decorations = raw.decorations as ResourceDecorations | undefined;
    const contextValue = typeof raw.contextValue === 'string' ? raw.contextValue : undefined;
    const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath : undefined;
    const diffTitle = typeof raw.diffTitle === 'string' ? raw.diffTitle : undefined;
    const revision = typeof raw.revision === 'string' ? raw.revision : '@';
    const status = raw.status as JjStatusEntry['status'] | undefined;

    return {
        resourceUri,
        relativePath,
        command,
        decorations,
        contextValue,
        leftUri,
        rightUri,
        diffTitle,
        revision,
        status,
    };
}

function unpackContextPayload(payload: unknown): unknown {
    if (typeof payload !== 'object' || payload === null) {
        return payload;
    }
    const record = payload as Record<string, unknown>;
    if ('resourceState' in record && record.resourceState && typeof record.resourceState === 'object') {
        const raw = record.resourceState as Record<string, unknown>;
        return reviveResourceState(raw);
    }
    if ('resourceStates' in record && Array.isArray(record.resourceStates)) {
        return {
            ...record,
            resourceStates: record.resourceStates.map((s) =>
                typeof s === 'object' && s !== null ? reviveResourceState(s as Record<string, unknown>) : s,
            ),
        };
    }
    return payload;
}

async function handleAction(command: string, payload?: unknown): Promise<void> {
    if (webHostEnv) {
        const resolvedPayload = unpackContextPayload(payload);
        await webHostEnv.commands.executeCommand(command, resolvedPayload);
    }
}

async function handleOpenResource(state: JjResourceState, options?: { preview?: boolean }): Promise<void> {
    if (state.leftUri && state.rightUri) {
        await loadDiffContents(state, options);
        return;
    }
    if (state.command) {
        await handleAction(state.command.command, state);
    } else {
        await loadDiffContents(state, options);
    }
}

function handleCommit(message: string): void {
    void handleAction('jj-view.commit', message);
}

function handleSetDescription(message: string): void {
    void handleAction('jj-view.setDescription', message);
}

function handleRefresh(): void {
    void handleAction('jj-view.refresh');
}

onMount(() => {
    let configSub: { dispose: () => void } | undefined;
    if (webHostEnv) {
        const initialTheme = webHostEnv.config.get<string>('appearance.theme') || 'pierre-dark-soft';
        void applyTheme(initialTheme);

        configSub = webHostEnv.config.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('appearance.theme')) {
                const newTheme = webHostEnv.config.get<string>('appearance.theme') || 'pierre-dark-soft';
                void applyTheme(newTheme);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.selectTheme', async () => {
            await openThemePicker();
        });

        webHostEnv.commands.setContextKeySetter(rootContext);
        webHostEnv.ui.setQuickInputService(activeQuickInput);

        webHostEnv.documents.setDelegate({
            getActiveDocumentUri: () => {
                if (!activeTab) {
                    return undefined;
                }
                if (activeTab.view.type === 'diff') {
                    return activeTab.view.rightUri ?? activeTab.view.leftUri;
                }
                if (activeTab.view.type === 'file') {
                    return activeTab.view.uri;
                }
                return undefined;
            },
            getActiveDocumentSelections: () => activeTabSelection,
            getOpenDocumentUris: () => {
                const uris: Uri[] = [];
                for (const t of tabs) {
                    if (t.view.type === 'diff') {
                        if (t.view.rightUri) {
                            uris.push(t.view.rightUri);
                        }
                        if (t.view.leftUri) {
                            uris.push(t.view.leftUri);
                        }
                    } else if (t.view.type === 'file') {
                        uris.push(t.view.uri);
                    }
                }
                return uris;
            },
            getOpenDiffTabs: (): readonly HostDiffTab[] => {
                const diffTabs: HostDiffTab[] = [];
                for (const t of tabs) {
                    if (t.view.type === 'diff' && t.view.leftUri && t.view.rightUri) {
                        const tabId = t.id;
                        diffTabs.push({
                            originalUri: t.view.leftUri,
                            modifiedUri: t.view.rightUri,
                            close: async () => {
                                closeTabById(tabId);
                            },
                        });
                    }
                }
                return diffTabs;
            },
            getOpenDocumentText: (uri: Uri) => {
                const uriStr = uri.toString();
                for (const t of tabs) {
                    if (t.view.type === 'diff') {
                        if (t.view.rightUri?.toString() === uriStr) {
                            return t.view.modifiedContent;
                        }
                        if (t.view.leftUri?.toString() === uriStr) {
                            return t.view.originalContent;
                        }
                    } else if (t.view.type === 'file' && t.view.uri.toString() === uriStr) {
                        return t.view.content;
                    }
                }
                return undefined;
            },
            saveIfDirty: async (uri: Uri) => {
                const uriStr = uri.toString();
                const targetTab = tabs.find(
                    (t) => t.isDirty && t.view.type === 'diff' && t.view.rightUri?.toString() === uriStr,
                );
                if (targetTab && targetTab.view.type === 'diff' && targetTab.view.rightUri) {
                    const content = targetTab.view.modifiedContent ?? '';
                    const rightUri = targetTab.view.rightUri;
                    if (rightUri.scheme === 'jj-edit' && editFs) {
                        await editFs.writeFile(rightUri, new TextEncoder().encode(content));
                    } else if (host) {
                        await host.fs.writeTextFile(rightUri.fsPath, content);
                    }
                    targetTab.isDirty = false;
                    webHostEnv?.documents.notifyDidSaveDocument(rightUri);
                    if (scmModel) {
                        await scmModel.refresh({ reason: 'save-diff' });
                    }
                }
            },
        });

        webHostEnv.nav.setCallbacks({
            onOpenSettings: async (_settingId) => {
                isSettingsOpen = true;
            },
            onOpenDiff: async (leftUri, rightUri, title, options) => {
                const normPath = rightUri?.path || leftUri?.path || '';
                const cleanPath = normPath.startsWith('/') ? normPath.slice(1) : normPath;
                let matchingState: JjResourceState | undefined;
                if (currentSnapshot?.conflictedPaths.some((p) => p === cleanPath || normPath.endsWith(p))) {
                    matchingState = createJjResourceState(
                        { path: cleanPath, status: 'modified', conflicted: true },
                        '@',
                        workspaceRoot,
                        {
                            openDiffOnClick: true,
                            inConflictGroup: true,
                            workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
                        },
                    );
                } else {
                    const change = currentSnapshot?.workingCopyChanges?.find(
                        (c) => c.path === cleanPath || normPath.endsWith(c.path),
                    );
                    if (change) {
                        matchingState = createJjResourceState(change, '@', workspaceRoot, {
                            squashable: currentSnapshot.parentMutable,
                            multipleAncestors: (currentSnapshot.ancestors.length ?? 0) > 1,
                            openDiffOnClick: true,
                            hasChild: currentSnapshot.hasChild,
                            workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
                        });
                    }
                }
                await loadDiffFromUris(leftUri, rightUri, title, matchingState, options);
            },
            onOpenFile: async (uri, options) => {
                await loadDiffFromUris(undefined, uri, uri.fsPath, undefined, options);
            },
            onOpenMergeEditor: async (resourceUri) => {
                const normPath = resourceUri.path;
                const cleanPath = normPath.startsWith('/') ? normPath.slice(1) : normPath;
                const conflictPath =
                    currentSnapshot?.conflictedPaths.find((p) => p === cleanPath || normPath.endsWith(p)) || cleanPath;
                const state = createJjResourceState(
                    { path: conflictPath, status: 'modified', conflicted: true },
                    '@',
                    workspaceRoot,
                    {
                        openDiffOnClick: true,
                        inConflictGroup: true,
                        workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
                    },
                );
                await loadDiffContents(state, { preview: false });
            },
            onOpenCommitDetails: async (changeId, options) => {
                openOrActivateTab({ type: 'commit-details', changeId }, options);
            },
            onFocusScmInput: async () => {
                const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="scm-input-textarea"]');
                textarea?.focus();
            },
            onHighlightCommit: (_repoRoot, changeId) => {
                if (logTransport) {
                    void logTransport.postMessage({
                        type: 'setHighlight',
                        payload: { changeId },
                    });
                }
            },
            onOpenMultiDiff: async (title, resources, options) => {
                if (resources.length === 0) {
                    return;
                }

                const loadedFiles: MultiDiffFileEntry[] = await Promise.all(
                    resources.map(async (r) => {
                        const [orig, mod] = await Promise.all([
                            resolveUriContent(r.leftUri),
                            resolveUriContent(r.rightUri),
                        ]);
                        const filename = r.label || r.rightUri?.fsPath || r.leftUri?.fsPath || 'file';
                        const isWorkingCopy = r.rightUri?.scheme === 'file';
                        return {
                            filename,
                            originalContent: orig,
                            modifiedContent: mod,
                            leftUri: r.leftUri,
                            rightUri: r.rightUri,
                            isWorkingCopy,
                        };
                    }),
                );

                openOrActivateTab(
                    {
                        type: 'multi-diff',
                        title,
                        files: loadedFiles,
                    },
                    options,
                );
            },
            onCloseTab: async (uri) => {
                closeTabByUri(uri);
            },
        });
    } else {
        void applyTheme('pierre-dark-soft');
    }

    return () => {
        webHostEnv?.documents.setDelegate(undefined);
        rootContext.dispose();
        configSub?.dispose();
    };
});
</script>

<svelte:window onkeydown={handleWindowKeydown} oncontextmenu={handleWindowContextMenu} />

<AppLayout
    repoPath={workspaceRoot}
    onRefresh={handleRefresh}
>
    {#snippet scm()}
        <ScmPane
            snapshot={currentSnapshot}
            {workspaceRoot}
            {menuRegistry}
            {rootContext}
            openDiffOnClick={true}
            onOpenResource={handleOpenResource}
            onCommit={handleCommit}
            onSetDescription={handleSetDescription}
            onAction={handleAction}
        />
    {/snippet}

    {#snippet log()}
        {#if logTransport}
            <LogPane
                transport={logTransport}
                onRefresh={handleRefresh}
            />
        {/if}
    {/snippet}

    {#snippet main()}
        <div class="editor-main-area" data-testid="editor-main-area">
            {#if tabs.length > 0}
                <TabBar
                    {tabs}
                    {activeTabId}
                    onSelectTab={(id) => {
                        activeTabId = id;
                    }}
                    onCloseTab={(id) => {
                        closeTabById(id);
                    }}
                    onPinTab={(id) => {
                        pinTab(id);
                    }}
                    onReorderTabs={handleReorderTabs}
                />
            {/if}

            <div class="editor-body">
                {#if activeTab && activeTab.view.type === 'diff'}
                    {#key activeTab.id}
                        <PierreDiffViewer
                            filename={activeTab.title}
                            theme={activeTheme}
                            initialDirty={activeTab.isDirty ?? false}
                            originalContent={activeTab.view.originalContent ?? ''}
                            modifiedContent={activeTab.view.modifiedContent ?? ''}
                            fileStatus={activeTab.view.resourceState?.status}
                            isWorkingCopy={activeTab.view.resourceState
                                ? isWorkingCopyRevision(
                                      activeTab.view.resourceState.revision,
                                      currentSnapshot?.currentEntry?.change_id,
                                  )
                                : activeTab.view.rightUri?.scheme === 'file'}
                            isConflict={activeTab.view.resourceState?.status === 'conflicted' ||
                                (activeTab.view.resourceState?.contextValue?.toLowerCase().includes('allowopenmergeeditor') ?? false)}
                            parentMutable={currentSnapshot?.parentMutable ?? false}
                            onSave={handleSaveFile}
                            onDiscard={handleDiscardFile}
                            onResolveConflict={handleResolveConflict}
                            onDirtyChange={(d) => {
                                if (activeTab) {
                                    activeTab.isDirty = d;
                                    if (d) {
                                        activeTab.preview = false;
                                    }
                                }
                            }}
                            onContentChange={(text) => {
                                if (activeTab && activeTab.view.type === 'diff') {
                                    activeTab.view.modifiedContent = text;
                                }
                            }}
                            onSelectionChange={(ranges) => {
                                activeTabSelection = ranges;
                            }}
                            onSquashSelection={handleSquashSelection}
                        />
                    {/key}
                {:else if activeTab && activeTab.view.type === 'multi-diff'}
                    {#key activeTab.id}
                        <PierreMultiDiffViewer
                            title={activeTab.title}
                            files={activeTab.view.files}
                            theme={activeTheme}
                        />
                    {/key}
                {:else if activeTab && activeTab.view.type === 'commit-details' && commitDetailsBridge}
                    <CommitDetailsView
                        transport={commitDetailsBridge.transport}
                        onClose={() => {
                            if (activeTab) {
                                closeTabById(activeTab.id);
                            }
                        }}
                    />
                {:else}
                    <div class="empty-editor-message">
                        <i class="codicon codicon-source-control large-icon" aria-hidden="true"></i>
                        <h2>Source Control (JJ View)</h2>
                        <p>Select a changed file in the left pane to view diffs and make edits, or select a commit in the log.</p>
                    </div>
                {/if}
            </div>
        </div>
    {/snippet}
    {#snippet statusBar()}
        <StatusBar
            service={activeStatusBar}
            notificationService={activeNotifications}
            onOpenSettings={() => {
                isSettingsOpen = true;
            }}
        />
    {/snippet}
</AppLayout>

{#if isSettingsOpen}
    <SettingsModal
        hostSystem={host ?? webHostEnv?.system}
        hostConfig={webHostEnv?.config}
        {webHostEnv}
        onClose={() => {
            isSettingsOpen = false;
        }}
    />
{/if}

<QuickInput service={activeQuickInput} />
<NotificationContainer service={activeNotifications} />

{#if contextMenuState.visible}
    {#key `${contextMenuState.x}:${contextMenuState.y}`}
        <ContextMenu
            x={contextMenuState.x}
            y={contextMenuState.y}
            groups={contextMenuState.groups}
            onSelect={(cmd) => {
                void handleAction(cmd, contextMenuState.payload);
            }}
            onClose={closeContextMenu}
        />
    {/key}
{/if}

<style>
.editor-main-area {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--vscode-editor-background, #171717);
    color: var(--vscode-editor-foreground, #d4d4d4);
    overflow: hidden;
}

.editor-body {
    flex: 1;
    min-height: 0;
    width: 100%;
    position: relative;
    overflow: hidden;
}

.empty-editor-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--vscode-descriptionForeground, #8a8a8a);
    text-align: center;
    user-select: none;
}

.empty-editor-message h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    color: var(--vscode-foreground, #d4d4d4);
}

.empty-editor-message p {
    font-size: 13px;
    margin: 0;
    max-width: 360px;
    line-height: 1.5;
}

.large-icon {
    font-size: 48px;
    color: var(--vscode-icon-foreground, #8a8a8a);
    margin-bottom: 8px;
}
</style>
