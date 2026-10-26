<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import path from 'pathe';
import { onMount, untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { CommentsManager, CommentThread } from '../../src/core/comments-manager';
import { CommitDetailsController } from '../../src/core/controllers/commit-details-controller';
import { ProcessMonitorController } from '../../src/core/controllers/process-monitor-controller';
import { DiffTabCleaner } from '../../src/core/diff-tab-cleaner';
import type { HostDiffTab, HostOpenOptions } from '../../src/core/host/host-environment';
import type { FuzzyFileMatch } from '../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import type { JjEditFsService } from '../../src/core/jj-edit-fs-service';
import { JjProcessTracker } from '../../src/core/jj-process-tracker';
import type { JjRepository } from '../../src/core/jj-repository';
import type { JjRepositoryManager } from '../../src/core/jj-repository-manager';
import type { JjStatusEntry } from '../../src/core/jj-types';
import type { JjViewFsService } from '../../src/core/jj-view-fs-service';
import type { ScmModel, ScmSnapshot } from '../../src/core/scm-model';
import {
    createJjResourceState,
    type JjResourceState,
    type ResourceCommand,
    type ResourceDecorations,
} from '../../src/core/scm-resource-state';
import { getRevisionFromUri, getUriParams, isWorkingCopyRevision, Uri } from '../../src/core/uri-utils';
import type { WebviewTransport } from '../../src/core/webview/transport/types';
import { toError } from '../../src/utils/error-utils';
import { OutputChannel } from '../../src/utils/output-channel';
import { createInMemoryBridge, type InMemoryBridge } from './bridge/in-memory-bridge';
import CommentsPane from './comments/CommentsPane.svelte';
import { CommentsStore, type CommentThreadHandle, normalizeThreadPath } from './comments/comments-store.svelte';
import CommitDetailsView from './details/CommitDetailsView.svelte';
import {
    type EditorChatContextSelection,
    formatChatContextMessage,
    formatSelectionBadgeDetail,
    formatSelectionBadgeLabel,
} from './diff/chat-context-selection';
import { applyAppTheme, loadTheme } from './diff/highlighter-setup';
import PierreDiffViewer from './diff/PierreDiffViewer.svelte';
import PierreFileViewer from './diff/PierreFileViewer.svelte';
import PierreMultiDiffViewer from './diff/PierreMultiDiffViewer.svelte';
import type { WebHostEnvironment } from './host/web-host-environment';
import AppLayout from './layout/AppLayout.svelte';
import { LAYOUT_STORAGE_KEY, type PersistedLayout } from './layout/layout-state';
import LogPane from './log/LogPane.svelte';
import ContextMenu from './menu/ContextMenu.svelte';
import { ContextKeyService } from './menu/context-key-service';
import { extractVsCodeContext } from './menu/context-menu-utils';
import { DEFAULT_PACKAGE_JSON_CONTRIBUTES } from './menu/default-menus';
import { MenuRegistry } from './menu/menu-registry';
import type { ResolvedMenuItemGroup } from './menu/menu-types';
import { WhenEvaluator } from './menu/when-evaluator';
import MergeEditorView from './merge/MergeEditorView.svelte';
import { parseConflictMarkersFallback } from './merge/three-way-merge';
import ProcessMonitorView from './monitor/ProcessMonitorView.svelte';
import NotificationContainer from './notifications/NotificationContainer.svelte';
import { NotificationService } from './notifications/notification-service';
import OutputPane from './output/OutputPane.svelte';
import { WebOutputChannel } from './output/web-output-channel';
import { scoreFuzzyPath } from './quick-input/fuzzy-score';
import QuickInput from './quick-input/QuickInput.svelte';
import { type CommandPaletteEntry, QuickInputService } from './quick-input/quick-input-service';
import ScmPane from './scm/ScmPane.svelte';
import type { ScmRepositoryEntry } from './scm/scm-repo-types';
import SettingsModal from './settings/SettingsModal.svelte';
import { AVAILABLE_THEMES, THEME_DESCRIPTIONS } from './settings/settings-schema';
import StatusBar from './status/StatusBar.svelte';
import { StatusBarService } from './status/status-bar-service';
import TabBar from './tabs/TabBar.svelte';
import {
    COMMENTS_TAB_ID,
    getTabId,
    type MultiDiffFileEntry,
    OUTPUT_TAB_ID,
    PROCESS_MONITOR_TAB_ID,
    type TabEntry,
    type TabReorderPosition,
    type TabViewData,
} from './tabs/tab-types';

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

interface ChatContextSelectionProvider {
    getChatContextSelection: () => EditorChatContextSelection | null;
}

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
let tabs = $state<TabEntry[]>([]);
let activeTabId = $state<string | undefined>();
let activeTabSelection = $state<{ startLine: number; endLine: number }[] | undefined>(undefined);
let activeDiffViewerRef = $state<ChatContextSelectionProvider | null>(null);
let activeFileViewerRef = $state<ChatContextSelectionProvider | null>(null);
let activeMultiDiffViewerRef = $state<ChatContextSelectionProvider | null>(null);
let activeMergeViewerRef = $state<ChatContextSelectionProvider | null>(null);
let contextMenuSelectionSnapshot = $state<EditorChatContextSelection | null>(null);
let isSettingsOpen = $state(false);
let activeTheme = $state('pierre-dark-soft');

const activeTab = $derived(tabs.find((t) => t.id === activeTabId));

$effect(() => {
    const uri =
        activeTab?.view.type === 'diff'
            ? (activeTab.view.rightUri ?? activeTab.view.leftUri)
            : activeTab?.view.type === 'file' || activeTab?.view.type === 'merge'
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

$effect(() => {
    rootContext.set('ag.isSidecar', webHostEnv?.sidecar.isAvailable ?? false);
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
            id: 'workbench.action.quickOpen',
            title: 'Go to File...',
            category: 'File',
            iconClass: 'codicon codicon-go-to-file',
        },
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
        {
            id: 'jj-view.showOutput',
            title: 'Show Output Log',
            category: 'View',
            iconClass: 'codicon codicon-output',
        },
    ];

    for (const b of builtIns) {
        if (!seenIds.has(b.id)) {
            seenIds.add(b.id);
            commands.push(b);
        }
    }

    void activeQuickInput.openCommandPalette(commands, async (cmdId) => {
        if (cmdId === 'workbench.action.quickOpen') {
            await openQuickOpen();
            return;
        }
        if (cmdId === 'workbench.action.selectTheme') {
            await openThemePicker();
            return;
        }
        if (webHostEnv) {
            await webHostEnv.commands.executeCommand(cmdId);
        }
    });
}

interface QuickOpenFileItem {
    id: string;
    label: string;
    description?: string;
    detail?: string;
    iconClass: string;
    filterText: string;
    fullPath: string;
    priorityBoost: number;
}

function makeQuickOpenItem(
    fullPath: string,
    relPath: string,
    detail: string | undefined,
    priorityBoost: number,
): QuickOpenFileItem {
    const normRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const lastSlash = normRel.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? normRel.slice(lastSlash + 1) : normRel;
    const dirName = lastSlash > 0 ? normRel.slice(0, lastSlash) : undefined;
    return {
        id: normRel || fullPath,
        label: fileName || normRel,
        description: dirName,
        detail,
        iconClass: 'codicon codicon-file',
        filterText: normRel,
        fullPath,
        priorityBoost,
    };
}

function collectPrioritizedQuickOpenFiles(searchRoot: string): QuickOpenFileItem[] {
    const items: QuickOpenFileItem[] = [];
    const byFullPath = new Map<string, QuickOpenFileItem>();

    const toRelative = (fullPath: string): string | null => {
        const rel = path.relative(searchRoot, fullPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            return null;
        }
        return rel.replace(/\\/g, '/');
    };

    const modifiedStatusByFullPath = new Map<string, string>();
    const repoRoot = workspaceRoot || searchRoot;
    const snap = currentSnapshot ?? activeScmModel?.snapshot;
    if (snap?.conflictedPaths) {
        for (const p of snap.conflictedPaths) {
            const full = path.join(repoRoot, p);
            modifiedStatusByFullPath.set(full, 'Conflicted');
        }
    }
    if (snap?.workingCopyChanges) {
        for (const c of snap.workingCopyChanges) {
            if (c.status === 'deleted') {
                continue;
            }
            const full = path.join(repoRoot, c.path);
            if (!modifiedStatusByFullPath.has(full)) {
                modifiedStatusByFullPath.set(full, c.status === 'added' ? 'Added' : 'Modified');
            }
        }
    }

    // 1. Open tabs (active tab first, then remaining tabs)
    const orderedTabs = activeTab ? [activeTab, ...tabs.filter((t) => t.id !== activeTab.id)] : [...tabs];
    for (const t of orderedTabs) {
        let fullPath: string | undefined;
        if ((t.view.type === 'file' || t.view.type === 'merge') && t.view.uri.scheme === 'file') {
            fullPath = t.view.uri.fsPath;
        } else if (t.view.type === 'diff') {
            if (t.view.rightUri?.scheme === 'file') {
                fullPath = t.view.rightUri.fsPath;
            } else if (t.view.resourceState?.relativePath) {
                fullPath = path.join(repoRoot, t.view.resourceState.relativePath);
            }
        }
        if (!fullPath || byFullPath.has(fullPath)) {
            continue;
        }
        const rel = toRelative(fullPath);
        if (!rel) {
            continue;
        }
        const modBadge = modifiedStatusByFullPath.get(fullPath);
        const detail = modBadge ? `Open • ${modBadge}` : 'Open';
        const entry = makeQuickOpenItem(fullPath, rel, detail, 6000);
        byFullPath.set(fullPath, entry);
        items.push(entry);
    }

    // 2. Working-copy modified / added / conflicted files
    for (const [fullPath, statusLabel] of modifiedStatusByFullPath.entries()) {
        if (byFullPath.has(fullPath)) {
            continue;
        }
        const rel = toRelative(fullPath);
        if (!rel) {
            continue;
        }
        const entry = makeQuickOpenItem(fullPath, rel, statusLabel, 4000);
        byFullPath.set(fullPath, entry);
        items.push(entry);
    }

    return items;
}

function mergeQuickOpenItems(
    query: string,
    prioritized: readonly QuickOpenFileItem[],
    workspaceMatches: readonly FuzzyFileMatch[],
): QuickOpenFileItem[] {
    const trimmed = query.trim();
    if (!trimmed) {
        const seen = new Set<string>();
        const merged: QuickOpenFileItem[] = [];
        for (const p of prioritized) {
            seen.add(p.fullPath);
            merged.push(p);
        }
        for (const m of workspaceMatches) {
            if (seen.has(m.path)) {
                continue;
            }
            seen.add(m.path);
            merged.push(makeQuickOpenItem(m.path, m.relPath, undefined, 0));
        }
        return merged;
    }

    const scoredMap = new Map<string, { item: QuickOpenFileItem; score: number }>();

    for (const p of prioritized) {
        const s = scoreFuzzyPath(p.filterText, trimmed);
        if (s !== null) {
            scoredMap.set(p.fullPath, { item: p, score: s + p.priorityBoost });
        }
    }

    for (const m of workspaceMatches) {
        const existing = scoredMap.get(m.path);
        if (existing) {
            const boosted = m.score + existing.item.priorityBoost;
            if (boosted > existing.score) {
                existing.score = boosted;
            }
            continue;
        }
        scoredMap.set(m.path, {
            item: makeQuickOpenItem(m.path, m.relPath, undefined, 0),
            score: m.score,
        });
    }

    return Array.from(scoredMap.values())
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            if (b.item.priorityBoost !== a.item.priorityBoost) {
                return b.item.priorityBoost - a.item.priorityBoost;
            }
            return a.item.filterText.localeCompare(b.item.filterText);
        })
        .map((e) => e.item);
}

async function openQuickOpen(): Promise<void> {
    const searchRoot = workspaceRoot || webHostEnv?.workspace.workspaceFolders[0]?.uri.fsPath || host?.repoRoot || '';
    const searchRootUri = searchRoot ? Uri.file(searchRoot) : undefined;
    const initialPrioritized = searchRoot ? collectPrioritizedQuickOpenFiles(searchRoot) : [];

    if (searchRoot && host && searchRoot !== host.repoRoot) {
        void host.addAllowedRoot(searchRoot).catch(() => {});
    }

    let latestRequestId = 0;
    let activeAbortController: AbortController | null = null;
    let pickerClosed = false;

    const triggerBackendSearch = async (query: string): Promise<void> => {
        if (!webHostEnv && !host) {
            return;
        }
        const reqId = ++latestRequestId;
        if (activeAbortController) {
            activeAbortController.abort();
        }
        const abortController = new AbortController();
        activeAbortController = abortController;

        try {
            let matches: FuzzyFileMatch[] = [];
            if (webHostEnv) {
                matches = await webHostEnv.workspace.fuzzyFindFiles(query, searchRootUri, 100, abortController.signal);
            } else if (host && searchRoot) {
                matches = await host.fuzzyFindFiles(query, searchRoot, 100, undefined, abortController.signal);
            }
            if (pickerClosed || reqId !== latestRequestId) {
                return;
            }
            const livePrioritized = searchRoot ? collectPrioritizedQuickOpenFiles(searchRoot) : initialPrioritized;
            const merged = mergeQuickOpenItems(query, livePrioritized, matches);
            activeQuickInput.updateQuickPickItems(merged);
        } catch (err) {
            if (!abortController.signal.aborted) {
                console.warn('[QuickOpen] Backend fuzzy search failed:', err);
            }
        }
    };

    const pickPromise = activeQuickInput.showQuickPick(initialPrioritized, {
        title: 'Go to File',
        placeHolder: 'Search files by name (append space to match path segments)...',
        matchOnDescription: true,
        preserveOrder: true,
        onDidChangeValue: (val) => {
            void triggerBackendSearch(val);
        },
    });

    void triggerBackendSearch('');

    const selected = await pickPromise;
    pickerClosed = true;
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }

    if (selected?.fullPath) {
        await loadFileFromUri(Uri.file(selected.fullPath), { preview: false });
    }
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

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        void openQuickOpen();
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
    await loadDiffFromUris(
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
    if (!commentsStore || !activeTab || activeTab.view.type !== 'diff') {
        return [];
    }
    const relativePath = tabRelativePath(activeTab.view);
    return relativePath ? commentsStore.handlesForFile(relativePath) : [];
});

/** Threads for each entry of the active multi-diff tab, keyed by the entry's `filename`. */
const activeMultiDiffThreads = $derived.by((): ReadonlyMap<string, readonly CommentThreadHandle[]> => {
    const byFile = new Map<string, readonly CommentThreadHandle[]>();
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

function openCommentsTab(): void {
    openOrActivateTab({ type: 'comments' }, { preview: false });
}

function openOutputTab(): void {
    openOrActivateTab({ type: 'output' }, { preview: false });
}

function openProcessMonitorTab(): void {
    openOrActivateTab({ type: 'process-monitor' }, { preview: false });
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
            closeTabById(PROCESS_MONITOR_TAB_ID);
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
        openOutputTab();
    });
    return () => {
        sub.dispose();
    };
});

/** Everything a commit-details tab owns; disposed together with the tab. */
interface CommitDetailsSession {
    readonly bridge: InMemoryBridge;
    readonly controller: CommitDetailsController;
    dispose(): void;
}

const commitDetailsSessions = new SvelteMap<string, CommitDetailsSession>();

function ensureCommitDetailsSession(tab: TabEntry): void {
    if (tab.view.type !== 'commit-details') {
        return;
    }
    const model = activeScmModel;
    const hostEnv = webHostEnv;
    if (!model || !hostEnv) {
        return;
    }
    const tabId = tab.id;
    const changeId = tab.view.changeId;
    untrack(() => {
        if (commitDetailsSessions.has(tabId)) {
            return;
        }
        const controller = new CommitDetailsController(changeId, model.repo, hostEnv, {
            logger: new OutputChannel(activeOutputChannel, 'CommitDetails'),
            openDiff: async ({ file, changeId: cId, isImmutable, isWorkingCopy }) => {
                await openFileDiffForChange(file, cId, isWorkingCopy ?? false, { preview: true }, isImmutable);
            },
        });
        // An edited draft pins the tab, like a dirty file editor, so clicking
        // another commit opens a fresh preview instead of discarding the text.
        const syncDirty = (): void => {
            const liveTab = tabs.find((t) => t.id === tabId);
            if (!liveTab) {
                return;
            }
            const dirty = controller.hasUnsavedDraft;
            if (liveTab.isDirty === dirty) {
                return;
            }
            liveTab.isDirty = dirty;
            if (dirty) {
                liveTab.preview = false;
            }
        };
        const bridge = createInMemoryBridge(async (msg) => {
            await controller.handleMessage(msg);
            syncDirty();
        });
        const subscriptions = [
            controller.addMessenger(bridge.messenger),
            controller.onDidUpdate(syncDirty),
            // Like the extension's editor provider: re-load on every repository
            // status change so an external describe/abandon or a working-copy
            // edit reaches the open details view. load() keeps an unsaved draft
            // and closes the view when the revision no longer exists.
            model.repo.onDidStatusChange(() => {
                void controller.load();
            }),
        ];
        void controller.load();
        commitDetailsSessions.set(tabId, {
            bridge,
            controller,
            dispose: () => {
                for (const subscription of subscriptions) {
                    subscription.dispose();
                }
                controller.dispose();
            },
        });
    });
}

const activeCommitDetailsSession = $derived(activeTab ? commitDetailsSessions.get(activeTab.id) : undefined);

function openOrActivateTab(view: TabViewData, options?: HostOpenOptions): void {
    const tabId = getTabId(view);
    const existingIndex = tabs.findIndex((t) => t.id === tabId);

    if (existingIndex >= 0) {
        activeTabId = tabId;
        const existingTab = tabs[existingIndex];
        if (existingTab && view.type === 'diff' && existingTab.view.type === 'diff') {
            if (!existingTab.isDirty) {
                if (view.originalContent) {
                    existingTab.view.originalContent = view.originalContent;
                }
                if (view.modifiedContent) {
                    existingTab.view.modifiedContent = view.modifiedContent;
                }
            }
        }
        if (existingTab && view.type === 'multi-diff' && existingTab.view.type === 'multi-diff') {
            existingTab.view.files = view.files;
        }
        if (existingTab && view.type === 'merge' && existingTab.view.type === 'merge') {
            if (view.loaded) {
                existingTab.view.baseContent = view.baseContent;
                existingTab.view.leftContent = view.leftContent;
                existingTab.view.rightContent = view.rightContent;
                existingTab.view.loaded = true;
            }
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
    } else if (view.type === 'merge') {
        title = view.title;
        tooltip = view.uri.fsPath || view.title;
        iconClass = 'codicon codicon-git-merge';
    } else if (view.type === 'comments') {
        title = 'Comments';
        tooltip = 'Review comments';
        iconClass = 'codicon codicon-comment-discussion';
    } else if (view.type === 'output') {
        title = 'Output';
        tooltip = 'JJ View diagnostic output channel';
        iconClass = 'codicon codicon-output';
    } else if (view.type === 'process-monitor') {
        title = 'Process Monitor';
        tooltip = 'JJ Process & Performance Monitor';
        iconClass = 'codicon codicon-pulse';
    }

    const isPreview = options?.preview ?? view.type === 'commit-details';
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
            ensureCommitDetailsSession(tabs[previewIndex]);
            return;
        }
    }

    tabs.push(newTab);
    activeTabId = newTab.id;
    ensureCommitDetailsSession(tabs[tabs.length - 1]);
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
        if (t.view.type === 'file' || t.view.type === 'merge') {
            return t.view.uri.toString() === uriStr;
        }
        return false;
    });
    for (const t of toClose) {
        closeTabById(t.id);
    }
}

function closeOtherTabs(targetTabId: string): void {
    if (!tabs.some((t) => t.id === targetTabId)) {
        return;
    }
    tabs = tabs.filter((t) => t.id === targetTabId);
    activeTabId = targetTabId;
}

function closeTabsToTheRight(targetTabId: string): void {
    const idx = tabs.findIndex((t) => t.id === targetTabId);
    if (idx === -1) {
        return;
    }
    tabs = tabs.slice(0, idx + 1);
    if (!tabs.some((t) => t.id === activeTabId)) {
        activeTabId = targetTabId;
    }
}

function closeAllTabs(): void {
    tabs = [];
    activeTabId = undefined;
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
    const start = performance.now();
    let content = '';
    if (uri.scheme === 'file' && host) {
        content = await host.fs.readTextFile(uri.fsPath);
    } else if (uri.scheme === 'jj-view' && viewFs) {
        const bytes = await viewFs.readFile(uri);
        content = new TextDecoder().decode(bytes);
    } else if (uri.scheme === 'jj-edit' && editFs) {
        const bytes = await editFs.readFile(uri);
        content = new TextDecoder().decode(bytes);
    }
    const duration = performance.now() - start;
    if (typeof console !== 'undefined' && console.log) {
        console.log(
            `[Perf:App] resolveUriContent(${uri.scheme}://${uri.path || uri.fsPath}) took ${duration.toFixed(1)}ms (${content.length} chars)`,
        );
    }
    return content;
}

async function loadDiffFromUris(
    leftUri?: Uri,
    rightUri?: Uri,
    title?: string,
    resourceState?: JjResourceState,
    options?: HostOpenOptions,
): Promise<void> {
    const start = performance.now();
    const diffTitle = title || rightUri?.fsPath || leftUri?.fsPath || 'Diff';
    if (typeof console !== 'undefined' && console.log) {
        console.log(`[Perf:App] loadDiffFromUris(${diffTitle}) starting`);
    }
    const tabId = getTabId({
        type: 'diff',
        leftUri,
        rightUri,
        title: diffTitle,
    });
    const existingTab = tabs.find((t) => t.id === tabId);
    if (
        existingTab &&
        existingTab.view.type === 'diff' &&
        (existingTab.view.loaded ||
            existingTab.isDirty ||
            existingTab.view.originalContent ||
            existingTab.view.modifiedContent)
    ) {
        activeTabId = tabId;
        if (options?.preview === false && existingTab.preview) {
            existingTab.preview = false;
        }
        return;
    }

    openOrActivateTab(
        {
            type: 'diff',
            leftUri,
            rightUri,
            title: diffTitle,
            resourceState,
            originalContent: '',
            modifiedContent: '',
            loaded: false,
        },
        options,
    );

    try {
        const [leftText, rightText] = await Promise.all([resolveUriContent(leftUri), resolveUriContent(rightUri)]);
        const targetTab = tabs.find((t) => t.id === tabId);
        if (targetTab && targetTab.view.type === 'diff') {
            targetTab.view.originalContent = leftText;
            if (!targetTab.isDirty) {
                targetTab.view.modifiedContent = rightText;
            }
            targetTab.view.loaded = true;
        }
        const totalDuration = performance.now() - start;
        if (typeof console !== 'undefined' && console.log) {
            console.log(
                `[Perf:App] loadDiffFromUris(${diffTitle}) resolved in ${totalDuration.toFixed(1)}ms (left: ${leftText.length} chars, right: ${rightText.length} chars)`,
            );
        }
    } catch (err) {
        console.error('Failed to load file contents for diff:', err);
    }
}

async function loadDiffContents(state: JjResourceState, options?: HostOpenOptions): Promise<void> {
    await loadDiffFromUris(state.leftUri, state.rightUri, state.diffTitle || state.resourceUri.fsPath, state, options);
}

let documentReloadGeneration = 0;

/**
 * Re-reads the contents of every open diff and file tab. Called after each
 * SCM snapshot so that tabs follow the repository the way VS Code editors
 * follow a FileSystemProvider's change events. Dirty buffers keep the user's
 * edits on the modified side; only the original side is refreshed for them.
 */
async function reloadOpenDocumentTabs(): Promise<void> {
    const generation = ++documentReloadGeneration;
    const reloads: Promise<void>[] = [];
    for (const tab of tabs) {
        const tabId = tab.id;
        if (tab.view.type === 'diff' && tab.view.loaded) {
            const { leftUri, rightUri } = tab.view;
            reloads.push(
                (async () => {
                    const [leftText, rightText] = await Promise.all([
                        resolveUriContent(leftUri),
                        resolveUriContent(rightUri),
                    ]);
                    if (generation !== documentReloadGeneration) {
                        return;
                    }
                    const target = tabs.find((t) => t.id === tabId);
                    if (!target || target.view.type !== 'diff') {
                        return;
                    }
                    if (target.view.originalContent !== leftText) {
                        target.view.originalContent = leftText;
                    }
                    if (!target.isDirty && target.view.modifiedContent !== rightText) {
                        target.view.modifiedContent = rightText;
                    }
                })(),
            );
            continue;
        }
        if (tab.view.type === 'file' && !tab.isDirty) {
            const { uri } = tab.view;
            reloads.push(
                (async () => {
                    const content = await resolveUriContent(uri);
                    if (generation !== documentReloadGeneration) {
                        return;
                    }
                    const target = tabs.find((t) => t.id === tabId);
                    if (!target || target.view.type !== 'file' || target.isDirty || target.view.content === content) {
                        return;
                    }
                    target.view.content = content;
                })(),
            );
            continue;
        }
        if (tab.view.type === 'multi-diff') {
            const files = tab.view.files;
            reloads.push(
                (async () => {
                    const contents = await Promise.all(
                        files.map(async (file) => {
                            const [originalContent, modifiedContent] = await Promise.all([
                                resolveUriContent(file.leftUri),
                                resolveUriContent(file.rightUri),
                            ]);
                            return { originalContent, modifiedContent };
                        }),
                    );
                    if (generation !== documentReloadGeneration) {
                        return;
                    }
                    const target = tabs.find((t) => t.id === tabId);
                    if (!target || target.view.type !== 'multi-diff' || target.view.files !== files) {
                        return;
                    }
                    const changed = files.some(
                        (file, i) =>
                            file.originalContent !== contents[i].originalContent ||
                            file.modifiedContent !== contents[i].modifiedContent,
                    );
                    if (!changed) {
                        return;
                    }
                    // The multi-diff viewer re-renders on array identity, not on
                    // nested fields, so swap in a new array rather than mutating.
                    target.view.files = files.map((file, i) => ({ ...file, ...contents[i] }));
                })(),
            );
        }
    }
    try {
        await Promise.all(reloads);
    } catch (err) {
        console.error('Failed to reload open documents after repository change:', err);
    }
}

async function loadFileFromUri(uri: Uri, options?: HostOpenOptions): Promise<void> {
    const normPath = uri.path || uri.fsPath || '';
    const cleanPath = normPath.startsWith('/') ? normPath.slice(1) : normPath;
    const fileName = cleanPath.split('/').filter(Boolean).pop() || cleanPath || 'file';

    let matchingState: JjResourceState | undefined;
    const uriRevision = uri.scheme === 'file' ? '@' : (getRevisionFromUri(uri) ?? '@');
    const isWc = isWorkingCopyRevision(uriRevision, currentSnapshot?.currentEntry?.change_id);
    if (isWc) {
        const change = currentSnapshot?.workingCopyChanges?.find(
            (c) => c.path === cleanPath || normPath.endsWith(c.path),
        );
        if (change) {
            matchingState = createJjResourceState(change, '@', workspaceRoot, {
                squashable: currentSnapshot?.parentMutable ?? false,
                multipleAncestors: (currentSnapshot?.ancestors.length ?? 0) > 1,
                openDiffOnClick: true,
                hasChild: currentSnapshot?.hasChild ?? false,
                workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
            });
        }
    } else if (uri.scheme === 'jj-edit') {
        matchingState = createJjResourceState({ path: cleanPath, status: 'modified' }, uriRevision, workspaceRoot, {
            editable: true,
            openDiffOnClick: true,
            workingCopyChangeId: currentSnapshot?.currentEntry?.change_id,
        });
    }

    openOrActivateTab(
        {
            type: 'file',
            uri,
            title: fileName,
            content: '',
            resourceState: matchingState,
        },
        options,
    );

    try {
        const content = await resolveUriContent(uri);
        const tabId = getTabId({ type: 'file', uri, title: fileName });
        const targetTab = tabs.find((t) => t.id === tabId);
        if (targetTab && targetTab.view.type === 'file') {
            if (!targetTab.isDirty) {
                targetTab.view.content = content;
            }
        }
    } catch (err) {
        console.error('Failed to load file contents for file viewer:', err);
    }
}

async function handleSaveFile(newContent: string): Promise<void> {
    if (!activeTab) {
        return;
    }
    let targetUri: Uri | undefined;
    if (activeTab.view.type === 'diff') {
        targetUri = activeTab.view.rightUri;
    } else if (activeTab.view.type === 'file' || activeTab.view.type === 'merge') {
        targetUri = activeTab.view.uri;
    }
    if (!targetUri) {
        return;
    }
    if (targetUri.scheme === 'jj-edit' && editFs) {
        await editFs.writeFile(targetUri, new TextEncoder().encode(newContent));
    } else if (host) {
        await host.fs.writeTextFile(targetUri.fsPath, newContent);
    }
    if (activeTab.view.type === 'diff') {
        activeTab.view.modifiedContent = newContent;
    } else if (activeTab.view.type === 'file') {
        activeTab.view.content = newContent;
    } else if (activeTab.view.type === 'merge') {
        activeTab.view.resolvedContent = newContent;
    }
    activeTab.isDirty = false;
    webHostEnv?.documents.notifyDidSaveDocument(targetUri);
    const targetScm = resolveScmModelForUri(targetUri);
    if (targetScm) {
        await targetScm.refresh({ reason: 'save-file' });
    }
}

async function handleDiscardFile(): Promise<void> {
    if (!activeTab) {
        return;
    }
    if (activeTab.view.type === 'diff' && activeTab.view.resourceState) {
        const state = activeTab.view.resourceState;
        await handleAction('jj-view.restore', state);
        const targetScm = resolveScmModelForUri(state.resourceUri);
        if (targetScm) {
            await targetScm.refresh({ reason: 'discard-file' });
        }
        closeTabById(activeTab.id);
        return;
    }
    if (activeTab.view.type === 'file') {
        if (activeTab.view.resourceState) {
            await handleAction('jj-view.restore', activeTab.view.resourceState);
            const targetScm = resolveScmModelForUri(activeTab.view.resourceState.resourceUri);
            if (targetScm) {
                await targetScm.refresh({ reason: 'discard-file' });
            }
        } else if (activeTab.view.uri.scheme === 'file' || activeTab.view.uri.scheme === 'jj-edit') {
            const content = await resolveUriContent(activeTab.view.uri);
            activeTab.view.content = content;
        }
        activeTab.isDirty = false;
        closeTabById(activeTab.id);
    }
}

async function handleResolveConflict(): Promise<void> {
    if (!activeTab || activeTab.view.type !== 'diff' || !activeTab.view.resourceState) {
        return;
    }
    const targetScm = resolveScmModelForUri(activeTab.view.resourceState.resourceUri);
    if (targetScm) {
        await targetScm.refresh({ reason: 'resolve-conflict' });
    }
    await loadDiffContents(activeTab.view.resourceState, { preview: false });
}

async function loadConflictPartsForResource(
    conflictPath: string,
    uri: Uri,
): Promise<{ base: string; left: string; right: string }> {
    const targetScm = resolveScmModelForUri(uri);
    if (targetScm) {
        try {
            return await targetScm.jj.getConflictParts(conflictPath);
        } catch {
            // Fall through to conflict marker fallback parser if jj resolve capture fails
        }
    }
    const rawContent = await resolveUriContent(uri);
    const parsed = parseConflictMarkersFallback(rawContent);
    if (parsed) {
        return parsed;
    }
    return { base: rawContent, left: rawContent, right: rawContent };
}

async function openMergeEditorForResource(state: JjResourceState, options?: HostOpenOptions): Promise<void> {
    const uri = state.resourceUri;
    const normPath = state.relativePath || uri.path || uri.fsPath || '';
    const cleanPath = normPath.startsWith('/') ? normPath.slice(1) : normPath;
    const targetScm = resolveScmModelForUri(uri);
    const targetSnap = targetScm?.snapshot ?? currentSnapshot;
    const conflictPath = targetSnap?.conflictedPaths.find((p) => p === cleanPath || normPath.endsWith(p)) || cleanPath;
    const fileName = conflictPath.split('/').filter(Boolean).pop() || conflictPath || 'Merge';
    const mergeTitle = `${fileName} (Merge)`;

    openOrActivateTab(
        {
            type: 'merge',
            uri,
            title: mergeTitle,
            baseContent: '',
            leftContent: '',
            rightContent: '',
            resourceState: state,
            loaded: false,
        },
        options ?? { preview: false },
    );

    try {
        const parts = await loadConflictPartsForResource(conflictPath, uri);
        const tabId = getTabId({
            type: 'merge',
            uri,
            title: mergeTitle,
            baseContent: '',
            leftContent: '',
            rightContent: '',
        });
        const targetTab = tabs.find((t) => t.id === tabId);
        if (!targetTab || targetTab.view.type !== 'merge') {
            return;
        }
        targetTab.view.baseContent = parts.base;
        targetTab.view.leftContent = parts.left;
        targetTab.view.rightContent = parts.right;
        targetTab.view.loaded = true;
    } catch (err) {
        console.error('Failed to load conflict parts for merge editor:', err);
    }
}

async function handleCompleteMerge(resolvedContent: string): Promise<void> {
    if (!activeTab || activeTab.view.type !== 'merge') {
        return;
    }
    const targetUri = activeTab.view.uri;
    const closingTabId = activeTab.id;
    if (targetUri.scheme === 'jj-edit' && editFs) {
        await editFs.writeFile(targetUri, new TextEncoder().encode(resolvedContent));
    } else if (host) {
        await host.fs.writeTextFile(targetUri.fsPath, resolvedContent);
    }
    activeTab.isDirty = false;
    webHostEnv?.documents.notifyDidSaveDocument(targetUri);
    const targetScm = resolveScmModelForUri(targetUri);
    if (targetScm) {
        await targetScm.refresh({ reason: 'complete-merge' });
    }
    closeTabById(closingTabId);
}

function resolveActiveChatContextSelection(): EditorChatContextSelection | null {
    if (!activeTab) {
        return null;
    }
    if (activeTab.view.type === 'diff') {
        return activeDiffViewerRef?.getChatContextSelection() ?? null;
    }
    if (activeTab.view.type === 'file') {
        return activeFileViewerRef?.getChatContextSelection() ?? null;
    }
    if (activeTab.view.type === 'multi-diff') {
        return activeMultiDiffViewerRef?.getChatContextSelection() ?? null;
    }
    if (activeTab.view.type === 'merge') {
        return activeMergeViewerRef?.getChatContextSelection() ?? null;
    }
    return null;
}

async function handleAddSelectionToChat(explicitSelection?: EditorChatContextSelection): Promise<void> {
    if (!webHostEnv?.sidecar.isAvailable) {
        void activeNotifications.showInformation('Chat context requires running inside Antigravity sidecar mode.');
        return;
    }

    const selection = explicitSelection ?? resolveActiveChatContextSelection() ?? contextMenuSelectionSnapshot;
    contextMenuSelectionSnapshot = null;

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
            void reloadOpenDocumentTabs();
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
        // Same order as the extension's SCM provider: drop cached virtual file
        // contents first, close tabs whose revision no longer exists, then
        // re-read whatever is still open so the reads miss the cache. Without
        // the invalidation, JjViewFsService keeps serving the previous diff
        // for a base|path pair until the page is reloaded.
        viewFs?.invalidateCache();
        editFs?.invalidateCache();
        await diffTabCleaner?.closeInvalidDiffEditors();
        void reloadOpenDocumentTabs();
    });
    // The initial refresh runs concurrently with mount; pick up a snapshot
    // that completed before this subscription attached.
    if (scmModel.snapshot && scmModel.snapshot !== currentSnapshot) {
        currentSnapshot = scmModel.snapshot;
    }
    return () => {
        repoDisposable.dispose();
        disposable.dispose();
    };
});

/**
 * Keeps commit-details sessions in step with the tab list: every
 * commit-details tab owns a session for its whole lifetime, and a session
 * is disposed as soon as its tab disappears, whatever path removed it
 * (close, close-others, preview replacement, ...). Creation normally
 * happens synchronously in openOrActivateTab; this effect only backfills
 * tabs opened before the SCM model or host environment were ready.
 */
$effect(() => {
    const liveIds = new Set<string>();
    for (const tab of tabs) {
        if (tab.view.type === 'commit-details') {
            liveIds.add(tab.id);
            ensureCommitDetailsSession(tab);
        }
    }
    untrack(() => {
        for (const [tabId, session] of commitDetailsSessions) {
            if (liveIds.has(tabId)) {
                continue;
            }
            session.dispose();
            commitDetailsSessions.delete(tabId);
        }
    });
});

$effect(() => {
    return () => {
        for (const session of commitDetailsSessions.values()) {
            session.dispose();
        }
        commitDetailsSessions.clear();
    };
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
    contextMenuSelectionSnapshot = null;
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
    if (menuId === 'editor/context') {
        contextMenuSelectionSnapshot = resolveActiveChatContextSelection();
    } else {
        contextMenuSelectionSnapshot = null;
    }
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
    if ('resourceUri' in record && record.resourceUri && typeof record.resourceUri === 'object') {
        const rawUri = record.resourceUri as Parameters<typeof Uri.revive>[0];
        return {
            ...record,
            resourceUri: Uri.revive(rawUri),
        };
    }
    if ('rootUri' in record && record.rootUri && typeof record.rootUri === 'object') {
        const rawUri = record.rootUri as Parameters<typeof Uri.revive>[0];
        return {
            ...record,
            rootUri: Uri.revive(rawUri),
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
    if (state.command?.command === 'jj-view.openMergeEditor') {
        await openMergeEditorForResource(state, options);
        return;
    }
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
        void applyTheme(initialTheme);

        configSub = webHostEnv.config.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('appearance.theme')) {
                const newTheme = webHostEnv.config.get<string>('appearance.theme') || 'pierre-dark-soft';
                void applyTheme(newTheme);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.quickOpen', async () => {
            await openQuickOpen();
        });

        webHostEnv.commands.registerCommand('workbench.action.selectTheme', async () => {
            await openThemePicker();
        });

        const extractTargetId = (payload?: unknown): string | undefined => {
            if (typeof payload === 'object' && payload !== null && 'tabId' in payload) {
                const rawId = (payload as { tabId: unknown }).tabId;
                if (typeof rawId === 'string' && rawId.length > 0) {
                    return rawId;
                }
            }
            return activeTabId;
        };

        webHostEnv.commands.registerCommand('workbench.action.closeActiveEditor', async (payload?: unknown) => {
            const targetId = extractTargetId(payload);
            if (targetId) {
                closeTabById(targetId);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.closeOtherEditors', async (payload?: unknown) => {
            const targetId = extractTargetId(payload);
            if (targetId) {
                closeOtherTabs(targetId);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.closeEditorsToTheRight', async (payload?: unknown) => {
            const targetId = extractTargetId(payload);
            if (targetId) {
                closeTabsToTheRight(targetId);
            }
        });

        webHostEnv.commands.registerCommand('workbench.action.closeAllEditors', async () => {
            closeAllTabs();
        });

        // showCommentsCommand (core) retargets the CommentsManager and then asks
        // the host to focus its comments panel; here that is the Comments tab.
        webHostEnv.commands.registerCommand('workbench.action.focusCommentsPanel', async () => {
            openCommentsTab();
        });

        webHostEnv.commands.registerCommand('jj-view.showOutput', async () => {
            openOutputTab();
        });

        webHostEnv.commands.registerCommand('workbench.action.output.toggleOutput', async () => {
            openOutputTab();
        });

        webHostEnv.commands.registerCommand('jj-view.showProcessMonitor', async () => {
            openProcessMonitorTab();
        });

        webHostEnv.commands.registerCommand('jj-view.addSelectionToChat', async () => {
            await handleAddSelectionToChat();
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
                if (activeTab.view.type === 'file' || activeTab.view.type === 'merge') {
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
                    } else if (t.view.type === 'file' || t.view.type === 'merge') {
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
                    } else if (t.view.type === 'merge' && t.view.uri.toString() === uriStr) {
                        return t.view.resolvedContent;
                    }
                }
                return undefined;
            },
            saveIfDirty: async (uri: Uri) => {
                const uriStr = uri.toString();
                const targetTab = tabs.find(
                    (t) =>
                        t.isDirty &&
                        ((t.view.type === 'diff' && t.view.rightUri?.toString() === uriStr) ||
                            ((t.view.type === 'file' || t.view.type === 'merge') && t.view.uri.toString() === uriStr)),
                );
                if (targetTab) {
                    let content = '';
                    let targetUri: Uri | undefined;
                    if (targetTab.view.type === 'diff' && targetTab.view.rightUri) {
                        content = targetTab.view.modifiedContent ?? '';
                        targetUri = targetTab.view.rightUri;
                    } else if (targetTab.view.type === 'file') {
                        content = targetTab.view.content ?? '';
                        targetUri = targetTab.view.uri;
                    } else if (targetTab.view.type === 'merge') {
                        content = targetTab.view.resolvedContent ?? '';
                        targetUri = targetTab.view.uri;
                    }
                    if (targetUri) {
                        if (targetUri.scheme === 'jj-edit' && editFs) {
                            await editFs.writeFile(targetUri, new TextEncoder().encode(content));
                        } else if (host) {
                            await host.fs.writeTextFile(targetUri.fsPath, content);
                        }
                        targetTab.isDirty = false;
                        webHostEnv?.documents.notifyDidSaveDocument(targetUri);
                        const targetScm = resolveScmModelForUri(targetUri);
                        if (targetScm) {
                            await targetScm.refresh({ reason: 'save-file' });
                        }
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
                await loadDiffFromUris(leftUri, rightUri, title, matchingState, options);
            },
            onOpenFile: async (uri, options) => {
                await loadFileFromUri(uri, options);
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
                await openMergeEditorForResource(state, { preview: false });
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

        if (webHostEnv.sidecar.isAvailable) {
            void webHostEnv.sidecar.getMetadata().then((meta) => {
                if (meta?.theme === 'light') {
                    void applyTheme('pierre-light');
                } else if (meta?.theme === 'high-contrast') {
                    void applyTheme('hc-black');
                }
            });
        }
    } else {
        void applyTheme('pierre-dark-soft');
    }

    return () => {
        webHostEnv?.documents.setDelegate(undefined);
        commentsStore?.dispose();
        rootContext.dispose();
        configSub?.dispose();
    };
});
</script>

<svelte:window onkeydown={handleWindowKeydown} oncontextmenu={handleWindowContextMenu} />

<AppLayout
    repoPath={workspaceRoot}
    onRefresh={handleRefresh}
    {activeTabId}
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
                    {#if activeTab.view.loaded === false}
                        <div class="editor-loading-placeholder"></div>
                    {:else}
                        {#key activeTab.id}
                            <PierreDiffViewer
                                bind:this={activeDiffViewerRef}
                                filename={activeTab.title}
                                resourceUri={activeTab.view.rightUri ?? activeTab.view.resourceState?.resourceUri}
                                theme={activeTheme}
                                initialDirty={activeTab.isDirty ?? false}
                                originalContent={activeTab.view.originalContent ?? ''}
                                modifiedContent={activeTab.view.modifiedContent ?? ''}
                                fileStatus={activeTab.view.resourceState?.status}
                                isWorkingCopy={activeTab.view.rightUri?.scheme === 'file' ||
                                    activeTab.view.rightUri?.scheme === 'jj-edit' ||
                                    (activeTab.view.resourceState
                                        ? isWorkingCopyRevision(
                                              activeTab.view.resourceState.revision,
                                              currentSnapshot?.currentEntry?.change_id,
                                          )
                                        : false)}
                                isConflict={activeTab.view.resourceState?.status === 'conflicted' ||
                                    (activeTab.view.resourceState?.contextValue?.toLowerCase().includes('allowopenmergeeditor') ?? false)}
                                parentMutable={currentSnapshot?.parentMutable ?? false}
                                commentThreads={activeDiffThreads}
                                onReplyToThread={replyToThread}
                                onSetThreadResolved={setThreadResolved}
                                onSave={handleSaveFile}
                                onDiscard={handleDiscardFile}
                                onResolveConflict={handleResolveConflict}
                                onOpenMergeEditor={() => {
                                    if (activeTab?.view.type === 'diff' && activeTab.view.resourceState) {
                                        void openMergeEditorForResource(activeTab.view.resourceState, { preview: false });
                                    }
                                }}
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
                                onAddSelectionToChat={() => handleAddSelectionToChat()}
                            />
                        {/key}
                    {/if}
                {:else if activeTab && activeTab.view.type === 'merge'}
                    {#if activeTab.view.loaded === false}
                        <div class="editor-loading-placeholder"></div>
                    {:else}
                        {#key activeTab.id}
                            <MergeEditorView
                                bind:this={activeMergeViewerRef}
                                filePath={activeTab.view.resourceState?.relativePath || activeTab.view.uri.fsPath || activeTab.title}
                                baseContent={activeTab.view.baseContent}
                                leftContent={activeTab.view.leftContent}
                                rightContent={activeTab.view.rightContent}
                                onCompleteMerge={handleCompleteMerge}
                                onSave={handleSaveFile}
                                onDirtyChange={(d) => {
                                    if (activeTab) {
                                        activeTab.isDirty = d;
                                        if (d) {
                                            activeTab.preview = false;
                                        }
                                    }
                                }}
                                onContentChange={(text) => {
                                    if (activeTab && activeTab.view.type === 'merge') {
                                        activeTab.view.resolvedContent = text;
                                    }
                                }}
                                onOpenTwoWayDiff={() => {
                                    if (activeTab?.view.type === 'merge' && activeTab.view.resourceState) {
                                        void loadDiffContents(activeTab.view.resourceState, { preview: false });
                                    }
                                }}
                                onAddSelectionToChat={() => handleAddSelectionToChat()}
                            />
                        {/key}
                    {/if}
                {:else if activeTab && activeTab.view.type === 'multi-diff'}
                    {#key activeTab.id}
                        <PierreMultiDiffViewer
                            bind:this={activeMultiDiffViewerRef}
                            title={activeTab.title}
                            files={activeTab.view.files}
                            theme={activeTheme}
                            commentThreads={activeMultiDiffThreads}
                            onReplyToThread={replyToThread}
                            onSetThreadResolved={setThreadResolved}
                            onAddSelectionToChat={() => handleAddSelectionToChat()}
                        />
                    {/key}
                {:else if activeTab && activeTab.view.type === 'file'}
                    {#key activeTab.id}
                        <PierreFileViewer
                            bind:this={activeFileViewerRef}
                            filename={activeTab.title}
                            resourceUri={activeTab.view.uri}
                            content={activeTab.view.content ?? ''}
                            theme={activeTheme}
                            initialDirty={activeTab.isDirty ?? false}
                            isWorkingCopy={activeTab.view.uri.scheme === 'file' || activeTab.view.uri.scheme === 'jj-edit'}
                            onSave={handleSaveFile}
                            onDiscard={handleDiscardFile}
                            onDirtyChange={(d) => {
                                if (activeTab) {
                                    activeTab.isDirty = d;
                                    if (d) {
                                        activeTab.preview = false;
                                    }
                                }
                            }}
                            onContentChange={(text) => {
                                if (activeTab && activeTab.view.type === 'file') {
                                    activeTab.view.content = text;
                                }
                            }}
                            onSelectionChange={(ranges) => {
                                activeTabSelection = ranges;
                            }}
                            onAddSelectionToChat={() => handleAddSelectionToChat()}
                        />
                    {/key}
                {:else if activeTab && activeTab.view.type === 'commit-details' && activeCommitDetailsSession}
                    {#key activeTab.id}
                        {@const sessionTabId = activeTab.id}
                        <CommitDetailsView
                            transport={activeCommitDetailsSession.bridge.transport}
                            onClose={() => closeTabById(sessionTabId)}
                        />
                    {/key}
                {:else if activeTab && activeTab.view.type === 'comments' && commentsStore}
                    <CommentsPane
                        store={commentsStore}
                        onOpenThread={openThreadLocation}
                        onReply={replyToThread}
                        onSetResolved={setThreadResolved}
                        onCopyUnresolved={() => {
                            void webHostEnv?.commands.executeCommand('jj-view.copyUnresolvedComments');
                        }}
                        onRefresh={() => {
                            void commentsManager?.refreshActiveChangeComments();
                        }}
                        onClose={() => closeTabById(COMMENTS_TAB_ID)}
                    />
                {:else if activeTab && activeTab.view.type === 'output'}
                    <OutputPane
                        channel={activeOutputChannel}
                        onClose={() => closeTabById(OUTPUT_TAB_ID)}
                    />
                {:else if activeTab && activeTab.view.type === 'process-monitor'}
                    <ProcessMonitorView
                        transport={processMonitorBridge.transport}
                        onClose={() => closeTabById(PROCESS_MONITOR_TAB_ID)}
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
            {activeProcessCount}
            onOpenProcessMonitor={() => {
                openProcessMonitorTab();
            }}
            onOpenOutput={() => {
                openOutputTab();
            }}
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

.editor-loading-placeholder {
    width: 100%;
    height: 100%;
    background-color: var(--vscode-editor-background, #171717);
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
