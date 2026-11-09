<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import path from 'pathe';
import { onMount } from 'svelte';
import type { CommentsManager, CommentThread } from '../../src/core/comments-manager';
import { ProcessMonitorController } from '../../src/core/controllers/process-monitor-controller';
import { DiffTabCleaner } from '../../src/core/diff-tab-cleaner';
import type { HostDiffTab, HostOpenOptions } from '../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import type { JjEditFsService } from '../../src/core/jj-edit-fs-service';
import { JjProcessTracker } from '../../src/core/jj-process-tracker';
import type { JjRepository } from '../../src/core/jj-repository';
import type { JjRepositoryManager } from '../../src/core/jj-repository-manager';
import type { JjStatusEntry } from '../../src/core/jj-types';
import type { JjViewFsService } from '../../src/core/jj-view-fs-service';
import type { ScmModel, ScmSnapshot } from '../../src/core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../src/core/scm-resource-state';
import { getRevisionFromUri, getUriParams, isWorkingCopyRevision, Uri } from '../../src/core/uri-utils';
import type { WebviewTransport } from '../../src/core/webview/transport/types';
import { toError } from '../../src/utils/error-utils';
import { OutputChannel } from '../../src/utils/output-channel';
import { openCommandPalette } from './app/command-palette';
import { ContextMenuController, unpackContextPayload } from './app/context-menu-controller.svelte';
import EditorWorkspace from './app/EditorWorkspace.svelte';
import { openQuickOpen } from './app/quick-open';
import { TabDocumentManager } from './app/tab-document-manager.svelte';
import { applyTheme, openThemePicker } from './app/theme-picker';
import { UpdateCoordinator } from './app/update-coordinator';
import { createInMemoryBridge } from './bridge/in-memory-bridge';
import { CommentsStore, type CommentThreadHandle, normalizeThreadPath } from './comments/comments-store.svelte';
import {
    type EditorChatContextSelection,
    formatChatContextMessage,
    formatSelectionBadgeDetail,
    formatSelectionBadgeLabel,
} from './diff/chat-context-selection';
import type { WebHostEnvironment } from './host/web-host-environment';
import AppLayout from './layout/AppLayout.svelte';
import { LAYOUT_STORAGE_KEY, type PersistedLayout } from './layout/layout-state';
import LogPane from './log/LogPane.svelte';
import ContextMenu from './menu/ContextMenu.svelte';
import { ContextKeyService } from './menu/context-key-service';
import { MenuRegistry } from './menu/menu-registry';
import NotificationContainer from './notifications/NotificationContainer.svelte';
import { NotificationService } from './notifications/notification-service';
import { WebOutputChannel } from './output/web-output-channel';
import QuickInput from './quick-input/QuickInput.svelte';
import { QuickInputService } from './quick-input/quick-input-service';
import ScmPane from './scm/ScmPane.svelte';
import type { ScmRepositoryEntry } from './scm/scm-repo-types';
import SettingsModal from './settings/SettingsModal.svelte';
import StatusBar from './status/StatusBar.svelte';
import { StatusBarService } from './status/status-bar-service';
import TabBar from './tabs/TabBar.svelte';
import { type MultiDiffFileEntry, PROCESS_MONITOR_TAB_ID, type TabViewData } from './tabs/tab-types';

interface Props {
    host?: RemoteHostSystem;
    webHostEnv?: WebHostEnvironment;
    repoManager?: JjRepositoryManager;
    scmModel?: ScmModel;
    getScmModel?: (repo: JjRepository) => ScmModel;
    initialSnapshot?: ScmSnapshot;
    workspaceRoot?: string;
    viewFs?: JjViewFsService;
    editFs?: JjEditFsService;
    logTransport?: WebviewTransport;
    quickInputService?: QuickInputService;
    notificationService?: NotificationService;
    statusBarService?: StatusBarService;
    /** Panel sizes restored from storage before mount, so the first paint is already right. */
    initialLayout?: PersistedLayout;
    /** Review comments for the active change; drives the Comments tab and inline diff threads. */
    commentsManager?: CommentsManager;
    /** Diagnostic output channel viewer backing `showJjError` "Show Log" and Output tab. */
    outputChannel?: WebOutputChannel;
    /** Tracker for running and historical `jj` CLI processes, powering the Process & Performance Monitor. */
    processTracker?: JjProcessTracker;
}

let {
    host,
    webHostEnv,
    repoManager,
    scmModel,
    getScmModel,
    initialSnapshot,
    workspaceRoot: initialWorkspaceRoot = '',
    viewFs,
    editFs,
    logTransport,
    quickInputService,
    notificationService,
    statusBarService,
    initialLayout,
    commentsManager,
    outputChannel,
    processTracker,
}: Props = $props();

const fallbackOutputChannel = new WebOutputChannel('JJ View');
const activeOutputChannel = $derived(outputChannel ?? fallbackOutputChannel);

const fallbackProcessTracker = new JjProcessTracker();
const activeProcessTracker = $derived(processTracker ?? fallbackProcessTracker);
// svelte-ignore state_referenced_locally
let activeProcessCount = $state<number>(activeProcessTracker.getMetrics().activeCount);

function persistLayout(layout: PersistedLayout): void {
    webHostEnv?.storage.update(LAYOUT_STORAGE_KEY, layout).catch((err: unknown) => {
        console.warn('Failed to persist layout', toError(err));
    });
}

const fallbackQuickInput = new QuickInputService();
const activeQuickInput = $derived(quickInputService ?? webHostEnv?.quickInput ?? fallbackQuickInput);

const fallbackNotifications = new NotificationService();
const activeNotifications = $derived(notificationService ?? webHostEnv?.notifications ?? fallbackNotifications);

const fallbackStatusBar = new StatusBarService();
const activeStatusBar = $derived(statusBarService ?? webHostEnv?.statusBar ?? fallbackStatusBar);

const menuRegistry = new MenuRegistry();
const rootContext = new ContextKeyService();

// svelte-ignore state_referenced_locally
let focusedRepo = $state<JjRepository | undefined>(repoManager?.focusedRepository ?? scmModel?.repo);
const activeScmModel = $derived(focusedRepo && getScmModel ? getScmModel(focusedRepo) : scmModel);
// svelte-ignore state_referenced_locally
let scmRepositories = $state<ScmRepositoryEntry[]>(
    repoManager && getScmModel
        ? repoManager.repositories.map((r) => ({
              workspaceRoot: r.rootUri.fsPath,
              snapshot: getScmModel(r).snapshot,
          }))
        : [],
);
// svelte-ignore state_referenced_locally
let currentSnapshot: ScmSnapshot | undefined = $state(initialSnapshot ?? scmModel?.snapshot);
// svelte-ignore state_referenced_locally
let currentRepoRoot = $state((repoManager?.focusedRepository ?? scmModel?.repo)?.rootUri.fsPath ?? '');
const workspaceRoot = $derived(currentRepoRoot || initialWorkspaceRoot);

function resolveScmModelForUri(uri?: Uri): ScmModel | undefined {
    if (uri && repoManager && getScmModel) {
        const matched = repoManager.getRepositoryForUri(uri);
        if (matched) {
            return getScmModel(matched);
        }
    }
    return activeScmModel;
}

let isSettingsOpen = $state(false);
let activeTheme = $state('pierre-dark-soft');

interface WorkspaceSelectionResolver {
    resolveActiveChatContextSelection: () => EditorChatContextSelection | null;
}
let editorWorkspaceRef = $state<WorkspaceSelectionResolver | null>(null);

function resolveActiveChatContextSelection(): EditorChatContextSelection | null {
    return editorWorkspaceRef?.resolveActiveChatContextSelection() ?? null;
}

const tabDocManager = new TabDocumentManager({
    get webHostEnv() {
        return webHostEnv;
    },
    get notificationService() {
        return activeNotifications;
    },
    get fsEditService() {
        return editFs;
    },
    get fsViewService() {
        return viewFs;
    },
    get remoteHostSystem() {
        return host;
    },
    resolveScmModelForUri,
    getCurrentSnapshot: () => currentSnapshot,
    getWorkspaceRoot: () => workspaceRoot,
    openFileDiffForChange: (file, changeId, isWorkingCopy, options, isImmutable) =>
        openFileDiffForChange(file, changeId, isWorkingCopy, options, isImmutable),
    handleAction: (cmd, payload) => handleAction(cmd, payload),
    get outputChannel() {
        return activeOutputChannel;
    },
});

const updateCoordinator = new UpdateCoordinator({
    get webHostEnv() {
        return webHostEnv;
    },
    get activeNotifications() {
        return activeNotifications;
    },
    get statusBarService() {
        return activeStatusBar;
    },
    get host() {
        return host;
    },
});

const contextMenuController = new ContextMenuController({
    menuRegistry,
    rootContext,
    handleAction: (cmd, payload) => handleAction(cmd, payload),
    resolveActiveChatContextSelection: () => resolveActiveChatContextSelection(),
});

$effect(() => {
    const activeTab = tabDocManager.activeTab;
    const uri =
        activeTab?.view.type === 'diff'
            ? (activeTab.view.rightUri ?? activeTab.view.leftUri)
            : activeTab?.view.type === 'file' || activeTab?.view.type === 'merge'
              ? activeTab.view.uri
              : undefined;
    tabDocManager.activeTabSelection = undefined;
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

$effect(() => {
    rootContext.set('ag.isSidecar', webHostEnv?.sidecar.isAvailable ?? false);
});

function triggerThemePicker(): Promise<void> {
    return openThemePicker(
        activeQuickInput,
        activeTheme,
        (name) => {
            activeTheme = name;
        },
        webHostEnv,
    );
}

function triggerQuickOpen(): Promise<void> {
    return openQuickOpen({
        activeQuickInput,
        workspaceRoot,
        currentSnapshot,
        activeScmSnapshot: activeScmModel?.snapshot,
        tabs: tabDocManager.tabs,
        activeTab: tabDocManager.activeTab,
        remoteHostSystem: host,
        webHostEnv,
        loadFileFromUri: (uri, options) => tabDocManager.loadFileFromUri(uri, options),
    });
}

function handleWindowKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        isSettingsOpen = true;
        return;
    }

    if (((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) || e.key === 'F1') {
        e.preventDefault();
        openCommandPalette({
            activeQuickInput,
            rootContext,
            activeStatusBar,
            openQuickOpen: () => triggerQuickOpen(),
            openThemePicker: () => triggerThemePicker(),
            performCheckForUpdates: (interactive) => updateCoordinator.performCheckForUpdates(interactive),
            performInstallUpdate: () => updateCoordinator.performInstallUpdate(),
            webHostEnv,
        });
        return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        void triggerQuickOpen();
        return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        if (tabDocManager.activeTabId) {
            e.preventDefault();
            tabDocManager.closeTabById(tabDocManager.activeTabId);
            return;
        }
    }
}

/** Opens the diff of `file` as changed by `changeId` (parent vs. that revision). */
async function openFileDiffForChange(
    file: JjStatusEntry,
    changeId: string,
    isWorkingCopy: boolean,
    options: HostOpenOptions,
    isImmutable?: boolean,
): Promise<void> {
    let editable = isWorkingCopy;
    if (!editable) {
        if (isImmutable !== undefined) {
            editable = !isImmutable;
        } else {
            const matchingAncestor = currentSnapshot?.ancestors.find(
                (a) =>
                    a.entry.change_id === changeId ||
                    a.entry.change_id.startsWith(changeId) ||
                    changeId.startsWith(a.entry.change_id),
            );
            if (matchingAncestor) {
                editable = matchingAncestor.isMutable;
            }
        }
    }
    const matchingState = createJjResourceState(file, changeId, workspaceRoot, {
        editable,
        openDiffOnClick: true,
        workingCopyChangeId: isWorkingCopy ? changeId : currentSnapshot?.currentEntry?.change_id,
    });
    await tabDocManager.loadDiffFromUris(
        matchingState.leftUri,
        matchingState.rightUri,
        `${file.path} (${changeId.slice(0, 8)})`,
        matchingState,
        options,
    );
}

// ---- Review comments ------------------------------------------------------

// The manager is wired once at startup; capturing the initial value is intentional.
// svelte-ignore state_referenced_locally
const commentsStore = commentsManager ? new CommentsStore(commentsManager) : undefined;

/** Repo-relative path for a file URI, for matching comment threads. */
function uriRelativePath(uri: Uri | undefined): string | undefined {
    if (!uri) {
        return undefined;
    }
    if (uri.scheme === 'file') {
        const root = commentsStore?.repoPath ?? workspaceRoot;
        return normalizeThreadPath(path.relative(root, uri.fsPath), undefined);
    }
    return normalizeThreadPath(uri.path, undefined);
}

/** Repo-relative path of the file a diff/file tab shows, for matching comment threads. */
function tabRelativePath(view: TabViewData): string | undefined {
    const uri = view.type === 'diff' ? (view.rightUri ?? view.leftUri) : view.type === 'file' ? view.uri : undefined;
    return uriRelativePath(uri);
}

const activeDiffThreads = $derived.by((): CommentThreadHandle[] => {
    const activeTab = tabDocManager.activeTab;
    if (!commentsStore || !activeTab || activeTab.view.type !== 'diff') {
        return [];
    }
    const relativePath = tabRelativePath(activeTab.view);
    return relativePath ? commentsStore.handlesForFile(relativePath) : [];
});

/** Threads for each entry of the active multi-diff tab, keyed by the entry's `filename`. */
const activeMultiDiffThreads = $derived.by((): ReadonlyMap<string, readonly CommentThreadHandle[]> => {
    const byFile = new Map<string, readonly CommentThreadHandle[]>();
    const activeTab = tabDocManager.activeTab;
    if (!commentsStore || !activeTab || activeTab.view.type !== 'multi-diff') {
        return byFile;
    }
    for (const entry of activeTab.view.files) {
        const relativePath = uriRelativePath(entry.rightUri ?? entry.leftUri);
        const handles = relativePath ? commentsStore.handlesForFile(relativePath) : [];
        if (handles.length > 0) {
            byFile.set(entry.filename, handles);
        }
    }
    return byFile;
});

/** The command payloads only need the thread id, but are typed on the host CommentThread shape. */
function toCommandThread(handle: CommentThreadHandle): CommentThread {
    const filePath = handle.thread.filePath ?? '';
    const root = commentsStore?.repoPath ?? workspaceRoot;
    return {
        id: handle.id,
        uri: Uri.file(path.isAbsolute(filePath) ? filePath : path.join(root, filePath)),
    };
}

async function replyToThread(handle: CommentThreadHandle, text: string, resolve: boolean): Promise<void> {
    const command = resolve ? 'jj-view.replyAndResolveComment' : 'jj-view.replyComment';
    await webHostEnv?.commands.executeCommand(command, { reply: { thread: toCommandThread(handle), text } });
}

async function setThreadResolved(handle: CommentThreadHandle, resolved: boolean): Promise<void> {
    const command = resolved ? 'jj-view.resolveCommentThread' : 'jj-view.unresolveCommentThread';
    await webHostEnv?.commands.executeCommand(command, { arg: toCommandThread(handle) });
}

function openThreadLocation(handle: CommentThreadHandle): void {
    const store = commentsStore;
    const changeId = store?.jjChangeId;
    const relativePath = store ? normalizeThreadPath(handle.thread.filePath, store.repoPath) : undefined;
    if (!changeId || !relativePath) {
        return;
    }
    const isWorkingCopy = changeId === currentSnapshot?.currentEntry?.change_id;
    void openFileDiffForChange({ path: relativePath, status: 'modified' }, changeId, isWorkingCopy, {
        preview: true,
    });
}

let processMonitorController: ProcessMonitorController | undefined;
const processMonitorBridge = createInMemoryBridge(async (msg) => {
    if (processMonitorController) {
        await processMonitorController.handleMessage(msg);
    }
});

$effect(() => {
    activeProcessCount = activeProcessTracker.getMetrics().activeCount;
    const sub = activeProcessTracker.onDidChangeProcesses(() => {
        activeProcessCount = activeProcessTracker.getMetrics().activeCount;
    });
    return () => {
        sub.dispose();
    };
});

$effect(() => {
    const tracker = activeProcessTracker;
    const hostEnv = webHostEnv;
    const logger = new OutputChannel(activeOutputChannel, 'ProcessMonitor');
    if (!hostEnv) {
        return;
    }
    const controller = new ProcessMonitorController(tracker, hostEnv, {
        messenger: processMonitorBridge.messenger,
        logger,
        onHidePanel: () => {
            tabDocManager.closeTabById(PROCESS_MONITOR_TAB_ID);
        },
    });
    processMonitorController = controller;
    return () => {
        if (processMonitorController === controller) {
            processMonitorController = undefined;
        }
        controller.dispose();
    };
});

$effect(() => {
    const sub = activeOutputChannel.onDidRequestShow(() => {
        tabDocManager.openOutputTab();
    });
    return () => {
        sub.dispose();
    };
});

async function handleAddSelectionToChat(explicitSelection?: EditorChatContextSelection): Promise<void> {
    if (!webHostEnv?.sidecar.isAvailable) {
        void activeNotifications.showInformation('Chat context requires running inside Antigravity sidecar mode.');
        return;
    }

    const selection =
        explicitSelection ?? resolveActiveChatContextSelection() ?? contextMenuController.contextMenuSelectionSnapshot;
    contextMenuController.contextMenuSelectionSnapshot = null;

    if (!selection) {
        void activeNotifications.showInformation('Select lines or text in the diff or file viewer first.');
        return;
    }

    const badgeLabel = formatSelectionBadgeLabel(selection);
    const badgeDetail = formatSelectionBadgeDetail(selection);
    const promptText = await activeQuickInput.showInputBox({
        title: 'Add Selection to Chat',
        prompt: 'Press Enter to send selection to chat (optional message)',
        placeHolder: 'Ask a question or describe what to do with this selection...',
        contextAttachment: {
            label: badgeLabel,
            detail: badgeDetail,
            snippet: selection.selectedText,
        },
    });

    if (promptText === undefined) {
        return;
    }

    const formattedMessage = formatChatContextMessage(selection, promptText);
    try {
        const res = await webHostEnv.sidecar.sendMessage(formattedMessage);
        if (res?.error) {
            void webHostEnv.ui.showErrorMessage(`Failed to send selection to chat: ${res.error}`);
            return;
        }
        void activeNotifications.showInformation(`Sent ${badgeLabel} to chat.`);
    } catch (err) {
        void webHostEnv.ui.showErrorMessage(`Failed to send selection to chat: ${toError(err).message}`);
    }
}

async function handleSquashSelection(ranges: { startLine: number; endLine: number }[]): Promise<void> {
    const activeTab = tabDocManager.activeTab;
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
    if (repoManager && getScmModel) {
        const modelSubscriptions = new Map<string, { dispose: () => void }>();

        const handleRepoSnapshot = async (repo: JjRepository, snapshot: ScmSnapshot): Promise<void> => {
            const rootPath = repo.rootUri.fsPath;
            scmRepositories = repoManager.repositories.map((r) => ({
                workspaceRoot: r.rootUri.fsPath,
                snapshot: r.rootUri.fsPath === rootPath ? snapshot : getScmModel(r).snapshot,
            }));
            const currentFocused = repoManager.focusedRepository ?? repoManager.repositories[0];
            if (currentFocused && currentFocused.rootUri.fsPath === rootPath) {
                focusedRepo = currentFocused;
                currentRepoRoot = rootPath;
                currentSnapshot = snapshot;
            }
            viewFs?.invalidateCache();
            editFs?.invalidateCache();
            if (webHostEnv) {
                const cleaner = new DiffTabCleaner(
                    repo.jj,
                    (uri) => repoManager.getRepositoryForUri(uri) === repo,
                    webHostEnv,
                );
                await cleaner.closeInvalidDiffEditors();
            }
            void tabDocManager.reloadOpenDocumentTabs();
        };

        const syncSubscriptions = (): void => {
            const activeRoots = new Set<string>();
            for (const repo of repoManager.repositories) {
                const rootPath = repo.rootUri.fsPath;
                activeRoots.add(rootPath);
                if (!modelSubscriptions.has(rootPath)) {
                    const model = getScmModel(repo);
                    const sub = model.onDidChangeSnapshot((snap) => {
                        void handleRepoSnapshot(repo, snap);
                    });
                    modelSubscriptions.set(rootPath, sub);
                }
            }
            for (const [rootPath, sub] of modelSubscriptions.entries()) {
                if (!activeRoots.has(rootPath)) {
                    sub.dispose();
                    modelSubscriptions.delete(rootPath);
                }
            }
            scmRepositories = repoManager.repositories.map((r) => ({
                workspaceRoot: r.rootUri.fsPath,
                snapshot: getScmModel(r).snapshot,
            }));
            const currentFocused = repoManager.focusedRepository ?? repoManager.repositories[0];
            if (currentFocused) {
                focusedRepo = currentFocused;
                currentRepoRoot = currentFocused.rootUri.fsPath;
                const focusedModel = getScmModel(currentFocused);
                if (focusedModel.snapshot) {
                    currentSnapshot = focusedModel.snapshot;
                }
            }
        };

        syncSubscriptions();
        const reposSub = repoManager.onDidChangeRepositories(() => {
            syncSubscriptions();
        });
        const focusSub = repoManager.onDidChangeFocusedRepository((r) => {
            focusedRepo = r;
            if (r) {
                currentRepoRoot = r.rootUri.fsPath;
                const focusedModel = getScmModel(r);
                currentSnapshot = focusedModel.snapshot;
            }
        });

        return () => {
            reposSub.dispose();
            focusSub.dispose();
            for (const sub of modelSubscriptions.values()) {
                sub.dispose();
            }
            modelSubscriptions.clear();
        };
    }

    if (!scmModel) {
        return;
    }
    const repoRoot = currentRepoRoot || scmModel.repo.rootUri.fsPath;
    const belongsToRepo = (uri: Uri): boolean => {
        const root = getUriParams(uri).get('root');
        return !root || root === repoRoot;
    };
    const diffTabCleaner = webHostEnv ? new DiffTabCleaner(scmModel.jj, belongsToRepo, webHostEnv) : undefined;

    const repoDisposable = scmModel.onDidChangeRepository((repo) => {
        currentRepoRoot = repo.rootUri.fsPath;
    });
    const disposable = scmModel.onDidChangeSnapshot(async (snapshot) => {
        currentSnapshot = snapshot;
        currentRepoRoot = scmModel.repo.rootUri.fsPath;
        viewFs?.invalidateCache();
        editFs?.invalidateCache();
        await diffTabCleaner?.closeInvalidDiffEditors();
        void tabDocManager.reloadOpenDocumentTabs();
    });
    if (scmModel.snapshot && scmModel.snapshot !== currentSnapshot) {
        currentSnapshot = scmModel.snapshot;
    }
    return () => {
        repoDisposable.dispose();
        disposable.dispose();
    };
});

$effect(() => {
    tabDocManager.syncCommitDetailsSessions();
});

$effect(() => {
    return () => {
        tabDocManager.disposeCommitDetailsSessions();
    };
});

async function handleAction(command: string, payload?: unknown): Promise<void> {
    if (webHostEnv) {
        const resolvedPayload = unpackContextPayload(payload);
        await webHostEnv.commands.executeCommand(command, resolvedPayload);
    }
}

async function handleOpenResource(state: JjResourceState, options?: { preview?: boolean }): Promise<void> {
    if (state.command?.command === 'jj-view.openMergeEditor') {
        await tabDocManager.openMergeEditorForResource(state, options);
        return;
    }
    if (state.leftUri && state.rightUri) {
        await tabDocManager.loadDiffContents(state, options);
        return;
    }
    if (state.command) {
        await handleAction(state.command.command, state);
    } else {
        await tabDocManager.loadDiffContents(state, options);
    }
}

function handleCommit(message: string, targetWorkspaceRoot?: string): void {
    if (targetWorkspaceRoot) {
        void handleAction('jj-view.commit', {
            description: message,
            rootUri: Uri.file(targetWorkspaceRoot),
        });
        return;
    }
    void handleAction('jj-view.commit', message);
}

function handleSetDescription(message: string, targetWorkspaceRoot?: string): void {
    if (targetWorkspaceRoot) {
        void handleAction('jj-view.setDescription', {
            description: message,
            rootUri: Uri.file(targetWorkspaceRoot),
        });
        return;
    }
    void handleAction('jj-view.setDescription', message);
}

function handleRefresh(): void {
    void handleAction('jj-view.refresh');
}

onMount(() => {
    let configSub: { dispose: () => void } | undefined;
    if (webHostEnv) {
        const initialTheme = webHostEnv.config.get<string>('appearance.theme') || 'pierre-dark-soft';
        void applyTheme(initialTheme, (name) => {
            activeTheme = name;
        });

        configSub = webHostEnv.config.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('appearance.theme')) {
                const newTheme = webHostEnv.config.get<string>('appearance.theme') || 'pierre-dark-soft';
                void applyTheme(newTheme, (name) => {
                    activeTheme = name;
                });
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.quickOpen', async () => {
            await triggerQuickOpen();
        });

        webHostEnv.commands.registerCommand('workbench.action.selectTheme', async () => {
            await triggerThemePicker();
        });

        const extractTargetId = (payload?: unknown): string | undefined => {
            if (typeof payload === 'object' && payload !== null && 'tabId' in payload) {
                const rawId = (payload as { tabId: unknown }).tabId;
                if (typeof rawId === 'string' && rawId.length > 0) {
                    return rawId;
                }
            }
            return tabDocManager.activeTabId;
        };

        webHostEnv.commands.registerCommand('workbench.action.closeActiveEditor', async (payload?: unknown) => {
            const targetId = extractTargetId(payload);
            if (targetId) {
                tabDocManager.closeTabById(targetId);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.closeOtherEditors', async (payload?: unknown) => {
            const targetId = extractTargetId(payload);
            if (targetId) {
                tabDocManager.closeOtherTabs(targetId);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.closeEditorsToTheRight', async (payload?: unknown) => {
            const targetId = extractTargetId(payload);
            if (targetId) {
                tabDocManager.closeTabsToTheRight(targetId);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.closeAllEditors', async () => {
            tabDocManager.closeAllTabs();
        });

        webHostEnv.commands.registerCommand('workbench.action.focusCommentsPanel', async () => {
            tabDocManager.openCommentsTab();
        });

        webHostEnv.commands.registerCommand('jj-view.showOutput', async () => {
            tabDocManager.openOutputTab();
        });

        webHostEnv.commands.registerCommand('workbench.action.output.toggleOutput', async () => {
            tabDocManager.openOutputTab();
        });

        webHostEnv.commands.registerCommand('jj-view.showProcessMonitor', async () => {
            tabDocManager.openProcessMonitorTab();
        });

        webHostEnv.commands.registerCommand('jj-view.addSelectionToChat', async () => {
            await handleAddSelectionToChat();
        });

        webHostEnv.commands.registerCommand('jj-view.checkForUpdates', async () => {
            await updateCoordinator.performCheckForUpdates(true);
        });

        webHostEnv.commands.registerCommand('jj-view.installUpdate', async () => {
            await updateCoordinator.performInstallUpdate();
        });

        webHostEnv.commands.setContextKeySetter(rootContext);
        webHostEnv.ui.setQuickInputService(activeQuickInput);

        webHostEnv.documents.setDelegate({
            getActiveDocumentUri: () => {
                const activeTab = tabDocManager.activeTab;
                if (!activeTab) {
                    return undefined;
                }
                if (activeTab.view.type === 'diff') {
                    return activeTab.view.rightUri ?? activeTab.view.leftUri;
                }
                if (activeTab.view.type === 'file' || activeTab.view.type === 'merge') {
                    return activeTab.view.uri;
                }
                return undefined;
            },
            getActiveDocumentSelections: () => tabDocManager.activeTabSelection,
            getOpenDocumentUris: () => {
                const uris: Uri[] = [];
                for (const t of tabDocManager.tabs) {
                    if (t.view.type === 'diff') {
                        if (t.view.rightUri) {
                            uris.push(t.view.rightUri);
                        }
                        if (t.view.leftUri) {
                            uris.push(t.view.leftUri);
                        }
                    } else if (t.view.type === 'file' || t.view.type === 'merge') {
                        uris.push(t.view.uri);
                    }
                }
                return uris;
            },
            getOpenDiffTabs: (): readonly HostDiffTab[] => {
                const diffTabs: HostDiffTab[] = [];
                for (const t of tabDocManager.tabs) {
                    if (t.view.type === 'diff' && t.view.leftUri && t.view.rightUri) {
                        const tabId = t.id;
                        diffTabs.push({
                            originalUri: t.view.leftUri,
                            modifiedUri: t.view.rightUri,
                            close: async () => {
                                tabDocManager.closeTabById(tabId);
                            },
                        });
                    }
                }
                return diffTabs;
            },
            getOpenDocumentText: (uri: Uri) => {
                const uriStr = uri.toString();
                for (const t of tabDocManager.tabs) {
                    if (t.view.type === 'diff') {
                        if (t.view.rightUri?.toString() === uriStr) {
                            return t.view.modifiedContent;
                        }
                        if (t.view.leftUri?.toString() === uriStr) {
                            return t.view.originalContent;
                        }
                    } else if (t.view.type === 'file' && t.view.uri.toString() === uriStr) {
                        return t.view.content;
                    } else if (t.view.type === 'merge' && t.view.uri.toString() === uriStr) {
                        return t.view.resolvedContent;
                    }
                }
                return undefined;
            },
            saveIfDirty: async (uri: Uri) => {
                await tabDocManager.saveUriIfDirty(uri);
            },
        });

        webHostEnv.nav.setCallbacks({
            onOpenSettings: async (_settingId) => {
                isSettingsOpen = true;
            },
            onOpenDiff: async (leftUri, rightUri, title, options) => {
                const normPath = rightUri?.path || leftUri?.path || '';
                const cleanPath = normPath.startsWith('/') ? normPath.slice(1) : normPath;
                const uriRev =
                    rightUri?.scheme === 'file'
                        ? '@'
                        : (rightUri && getRevisionFromUri(rightUri)) || (leftUri && getRevisionFromUri(leftUri)) || '@';
                const isWc = isWorkingCopyRevision(uriRev, currentSnapshot?.currentEntry?.change_id);
                let matchingState: JjResourceState | undefined;
                if (isWc) {
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
                } else {
                    const ancestorIdx =
                        currentSnapshot?.ancestors.findIndex(
                            (a) =>
                                a.entry.change_id === uriRev ||
                                a.entry.change_id.startsWith(uriRev) ||
                                uriRev.startsWith(a.entry.change_id),
                        ) ?? -1;
                    if (ancestorIdx >= 0 && currentSnapshot?.ancestors[ancestorIdx]) {
                        const ancestor = currentSnapshot.ancestors[ancestorIdx];
                        const remainingAncestors = currentSnapshot.ancestors.length - 1 - ancestorIdx;
                        const change = ancestor.changes.find(
                            (c) => c.path === cleanPath || normPath.endsWith(c.path),
                        ) ?? { path: cleanPath, status: 'modified' as const };
                        matchingState = createJjResourceState(change, ancestor.entry.change_id, workspaceRoot, {
                            editable: ancestor.isMutable || rightUri?.scheme === 'jj-edit',
                            squashable: ancestor.canSquash,
                            multipleAncestors: remainingAncestors > 0,
                            openDiffOnClick: true,
                            workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
                        });
                    } else if (rightUri?.scheme === 'jj-edit') {
                        matchingState = createJjResourceState(
                            { path: cleanPath, status: 'modified' },
                            uriRev,
                            workspaceRoot,
                            {
                                editable: true,
                                openDiffOnClick: true,
                                workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
                            },
                        );
                    }
                }
                await tabDocManager.loadDiffFromUris(leftUri, rightUri, title, matchingState, options);
            },
            onOpenFile: async (uri, options) => {
                await tabDocManager.loadFileFromUri(uri, options);
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
                await tabDocManager.openMergeEditorForResource(state, { preview: false });
            },
            onOpenCommitDetails: async (changeId, options) => {
                tabDocManager.openOrActivateTab({ type: 'commit-details', changeId }, options);
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
                            tabDocManager.resolveUriContent(r.leftUri),
                            tabDocManager.resolveUriContent(r.rightUri),
                        ]);
                        const rawFilename = r.label || r.rightUri?.fsPath || r.leftUri?.fsPath || 'file';
                        const filename = rawFilename.replace(/^[/\\]+/, '');
                        const isWorkingCopy = r.rightUri?.scheme === 'file' || r.rightUri?.scheme === 'jj-edit';
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

                tabDocManager.openOrActivateTab(
                    {
                        type: 'multi-diff',
                        title,
                        files: loadedFiles,
                    },
                    options,
                );
            },
            onCloseTab: async (uri) => {
                tabDocManager.closeTabByUri(uri);
            },
        });

        if (webHostEnv.sidecar.isAvailable) {
            void webHostEnv.sidecar.getMetadata().then((meta) => {
                if (meta?.theme === 'light') {
                    void applyTheme('pierre-light', (name) => {
                        activeTheme = name;
                    });
                } else if (meta?.theme === 'high-contrast') {
                    void applyTheme('hc-black', (name) => {
                        activeTheme = name;
                    });
                }
            });
        }
    } else {
        void applyTheme('pierre-dark-soft', (name) => {
            activeTheme = name;
        });
    }

    const updateSub = host?.onUpdateAvailable((info) => {
        updateCoordinator.handleUpdateInfo(info, false);
    });

    if (host || webHostEnv?.system?.checkUpdate) {
        void updateCoordinator.performCheckForUpdates(false);
    }

    return () => {
        webHostEnv?.documents.setDelegate(undefined);
        commentsStore?.dispose();
        rootContext.dispose();
        configSub?.dispose();
        updateSub?.dispose();
    };
});
</script>

<svelte:window onkeydown={handleWindowKeydown} oncontextmenu={(e) => contextMenuController.handleWindowContextMenu(e)} />

<AppLayout
    repoPath={workspaceRoot}
    onRefresh={handleRefresh}
    activeTabId={tabDocManager.activeTabId}
    layout={initialLayout}
    onLayoutChange={persistLayout}
>
    {#snippet scm()}
        <ScmPane
            snapshot={currentSnapshot}
            {workspaceRoot}
            repositories={scmRepositories}
            focusedWorkspaceRoot={currentRepoRoot || workspaceRoot}
            {menuRegistry}
            {rootContext}
            openDiffOnClick={true}
            isSidecarAvailable={Boolean(webHostEnv?.sidecar.isAvailable)}
            onDraftWithAgent={webHostEnv?.sidecar.isAvailable
                ? async () => {
                      try {
                          const res = await webHostEnv.sidecar.sendMessage(
                              'Please draft a concise and conventional commit message for the current working copy changes.',
                          );
                          if (res?.error) {
                              webHostEnv.ui.showErrorMessage(`Agent drafting failed: ${res.error}`);
                              return undefined;
                          }
                          return res?.response?.trim();
                      } catch (err) {
                          webHostEnv.ui.showErrorMessage(`Agent drafting error: ${toError(err).message}`);
                          return undefined;
                      }
                  }
                : undefined}
            onOpenResource={handleOpenResource}
            onCommit={handleCommit}
            onSetDescription={handleSetDescription}
            onAction={handleAction}
            onFocusRepository={(targetRoot) => {
                const matched = repoManager?.repositories.find((r) => r.rootUri.fsPath === targetRoot);
                if (matched) {
                    repoManager?.setFocusedRepository(matched);
                }
            }}
        />
    {/snippet}

    {#snippet log(logLayout)}
        {#if logTransport}
            <LogPane
                transport={logTransport}
                {menuRegistry}
                {rootContext}
                onAction={handleAction}
                collapsed={logLayout.collapsed}
                onToggleCollapsed={logLayout.onToggleCollapsed}
                onPreferredHeightChange={logLayout.onPreferredHeightChange}
            />
        {/if}
    {/snippet}

    {#snippet main()}
        <div class="editor-main-area" data-testid="editor-main-area">
            {#if tabDocManager.tabs.length > 0}
                <TabBar
                    tabs={tabDocManager.tabs}
                    activeTabId={tabDocManager.activeTabId}
                    onSelectTab={(id) => {
                        tabDocManager.activeTabId = id;
                    }}
                    onCloseTab={(id) => {
                        tabDocManager.closeTabById(id);
                    }}
                    onPinTab={(id) => {
                        tabDocManager.pinTab(id);
                    }}
                    onReorderTabs={(sourceId, targetId, position) => {
                        tabDocManager.handleReorderTabs(sourceId, targetId, position);
                    }}
                />
            {/if}

            <EditorWorkspace
                bind:this={editorWorkspaceRef}
                activeTab={tabDocManager.activeTab}
                {activeTheme}
                {currentSnapshot}
                {activeDiffThreads}
                {activeMultiDiffThreads}
                {commentsStore}
                {activeOutputChannel}
                {processMonitorBridge}
                activeCommitDetailsSession={tabDocManager.activeCommitDetailsSession}
                onDirtyChange={(dirty) => {
                    const activeTab = tabDocManager.activeTab;
                    if (activeTab) {
                        activeTab.isDirty = dirty;
                        if (dirty) {
                            activeTab.preview = false;
                        }
                    }
                }}
                onContentChange={(text) => {
                    const activeTab = tabDocManager.activeTab;
                    if (activeTab && activeTab.view.type === 'diff') {
                        activeTab.view.modifiedContent = text;
                    } else if (activeTab && activeTab.view.type === 'file') {
                        activeTab.view.content = text;
                    } else if (activeTab && activeTab.view.type === 'merge') {
                        activeTab.view.resolvedContent = text;
                    }
                }}
                onSaveFile={(newContent) => tabDocManager.handleSaveFile(newContent)}
                onDiscardFile={() => tabDocManager.handleDiscardFile()}
                onResolveConflict={() => tabDocManager.handleResolveConflict()}
                onOpenMergeEditor={(res) => {
                    void tabDocManager.openMergeEditorForResource(res, { preview: false });
                }}
                onCompleteMerge={(res) => tabDocManager.handleCompleteMerge(res)}
                onOpenTwoWayDiff={(res) => {
                    void tabDocManager.loadDiffContents(res, { preview: false });
                }}
                onSquashSelection={handleSquashSelection}
                onAddSelectionToChat={handleAddSelectionToChat}
                onReplyToThread={replyToThread}
                onSetThreadResolved={setThreadResolved}
                onOpenThreadLocation={openThreadLocation}
                onCloseTab={(id) => tabDocManager.closeTabById(id)}
                onSelectionChange={(ranges) => {
                    tabDocManager.activeTabSelection = ranges;
                }}
                onCopyUnresolvedComments={() => {
                    void webHostEnv?.commands.executeCommand('jj-view.copyUnresolvedComments');
                }}
                onRefreshComments={() => {
                    void commentsManager?.refreshActiveChangeComments();
                }}
            />
        </div>
    {/snippet}
    {#snippet statusBar()}
        <StatusBar
            service={activeStatusBar}
            notificationService={activeNotifications}
            {activeProcessCount}
            onOpenProcessMonitor={() => {
                tabDocManager.openProcessMonitorTab();
            }}
            onOpenOutput={() => {
                tabDocManager.openOutputTab();
            }}
            onOpenSettings={() => {
                isSettingsOpen = true;
            }}
            onTriggerUpdate={() => {
                void updateCoordinator.performInstallUpdate();
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

{#if contextMenuController.state.visible}
    {#key `${contextMenuController.state.x}:${contextMenuController.state.y}`}
        <ContextMenu
            x={contextMenuController.state.x}
            y={contextMenuController.state.y}
            groups={contextMenuController.state.groups}
            onSelect={(cmd) => {
                void handleAction(cmd, contextMenuController.state.payload);
            }}
            onClose={() => contextMenuController.closeContextMenu()}
        />
    {/key}
{/if}

<style>
.editor-main-area {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground, var(--vscode-foreground));
    overflow: hidden;
}
</style>
