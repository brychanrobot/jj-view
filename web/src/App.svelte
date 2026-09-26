<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import path from 'pathe';
import { onMount } from 'svelte';
import { CommitDetailsController } from '../../src/core/controllers/commit-details-controller';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import type { JjEditFsService } from '../../src/core/jj-edit-fs-service';
import type { JjViewFsService } from '../../src/core/jj-view-fs-service';
import type { ScmModel, ScmSnapshot } from '../../src/core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../src/core/scm-resource-state';
import { encodeJjViewQuery, isWorkingCopyRevision, Uri } from '../../src/core/uri-utils';
import type { WebviewTransport } from '../../src/core/webview/transport/types';
import { NO_OP_LOGGER } from '../../src/utils/output-channel';
import { createInMemoryBridge, type InMemoryBridge } from './bridge/in-memory-bridge';
import CommitDetailsView from './details/CommitDetailsView.svelte';
import { applyAppTheme, loadTheme } from './diff/highlighter-setup';
import PierreDiffViewer from './diff/PierreDiffViewer.svelte';
import PierreMultiDiffViewer, { type MultiDiffFileEntry } from './diff/PierreMultiDiffViewer.svelte';
import type { WebHostEnvironment } from './host/web-host-environment';
import AppLayout from './layout/AppLayout.svelte';
import LogPane from './log/LogPane.svelte';
import { ContextKeyService } from './menu/context-key-service';
import { DEFAULT_PACKAGE_JSON_CONTRIBUTES } from './menu/default-menus';
import { MenuRegistry } from './menu/menu-registry';
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

type ActiveView =
    | { type: 'diff'; leftUri?: Uri; rightUri?: Uri; title: string; resourceState?: JjResourceState }
    | { type: 'multi-diff'; title: string; files: MultiDiffFileEntry[] }
    | { type: 'commit-details'; changeId: string }
    | { type: 'empty' };

let currentSnapshot: ScmSnapshot | undefined = $state(initialSnapshot ?? scmModel?.snapshot);
let activeView = $state<ActiveView>({ type: 'empty' });
let originalContent = $state('');
let modifiedContent = $state('');
let isSettingsOpen = $state(false);
let activeTheme = $state('pierre-dark-soft');

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

async function openThemePicker(): Promise<void> {
    const items = AVAILABLE_THEMES.map((themeId, idx) => ({
        id: themeId,
        label: themeId,
        description: THEME_DESCRIPTIONS[idx] ?? '',
    }));
    const selected = await activeQuickInput.showQuickPick(items, {
        title: 'Select Color Theme',
        matchOnDescription: true,
    });
    if (selected && webHostEnv) {
        await webHostEnv.config.update('appearance.theme', selected.label);
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
}

let commitDetailsBridge: InMemoryBridge | null = $state(null);
let commitDetailsController: CommitDetailsController | null = null;

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
): Promise<void> {
    const diffTitle = title || rightUri?.fsPath || leftUri?.fsPath || 'Diff';
    activeView = {
        type: 'diff',
        leftUri,
        rightUri,
        title: diffTitle,
        resourceState,
    };

    try {
        const [leftText, rightText] = await Promise.all([resolveUriContent(leftUri), resolveUriContent(rightUri)]);
        originalContent = leftText;
        modifiedContent = rightText;
    } catch (err) {
        console.error('Failed to load file contents for diff:', err);
    }
}

async function loadDiffContents(state: JjResourceState): Promise<void> {
    await loadDiffFromUris(state.leftUri, state.rightUri, state.diffTitle || state.resourceUri.fsPath, state);
}

async function handleSaveFile(newContent: string): Promise<void> {
    if (activeView.type !== 'diff' || !activeView.rightUri) {
        return;
    }
    const rightUri = activeView.rightUri;
    if (rightUri.scheme === 'jj-edit' && editFs) {
        await editFs.writeFile(rightUri, new TextEncoder().encode(newContent));
    } else if (host) {
        await host.fs.writeTextFile(rightUri.fsPath, newContent);
    }
    modifiedContent = newContent;
    if (scmModel) {
        await scmModel.refresh({ reason: 'save-diff' });
    }
}

async function handleDiscardFile(): Promise<void> {
    if (activeView.type !== 'diff' || !activeView.resourceState) {
        return;
    }
    const state = activeView.resourceState;
    await handleAction('jj-view.restore', state);
    if (scmModel) {
        await scmModel.refresh({ reason: 'discard-file' });
    }
    activeView = { type: 'empty' };
}

async function handleResolveConflict(): Promise<void> {
    if (activeView.type !== 'diff' || !activeView.resourceState) {
        return;
    }
    if (scmModel) {
        await scmModel.refresh({ reason: 'resolve-conflict' });
    }
    await loadDiffContents(activeView.resourceState);
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
    if (activeView.type === 'commit-details' && scmModel && webHostEnv) {
        const changeId = activeView.changeId;
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
                await loadDiffFromUris(leftUri, rightUri, `${file.path} (${cId.slice(0, 8)})`, matchingState);
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

async function handleAction(command: string, payload?: unknown): Promise<void> {
    if (webHostEnv) {
        await webHostEnv.commands.executeCommand(command, payload);
    }
}

async function handleOpenResource(state: JjResourceState): Promise<void> {
    if (state.leftUri && state.rightUri) {
        await loadDiffContents(state);
        return;
    }
    if (state.command) {
        await handleAction(state.command.command, state);
    } else {
        await loadDiffContents(state);
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
        const applyTheme = async (themeName: string) => {
            activeTheme = themeName;
            try {
                const theme = await loadTheme(themeName);
                applyAppTheme(theme);
            } catch (err) {
                console.error(`Failed to load theme "${themeName}":`, err);
            }
        };

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
        webHostEnv.nav.setCallbacks({
            onOpenSettings: async (_settingId) => {
                isSettingsOpen = true;
            },
            onOpenDiff: async (leftUri, rightUri, title) => {
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
                await loadDiffFromUris(leftUri, rightUri, title, matchingState);
            },
            onOpenFile: async (uri) => {
                await loadDiffFromUris(undefined, uri, uri.fsPath);
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
                await loadDiffContents(state);
            },
            onOpenCommitDetails: async (changeId) => {
                activeView = { type: 'commit-details', changeId };
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
            onOpenMultiDiff: async (title, resources) => {
                if (resources.length === 0) {
                    activeView = { type: 'empty' };
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

                activeView = {
                    type: 'multi-diff',
                    title,
                    files: loadedFiles,
                };
            },
        });
    }

    return () => {
        rootContext.dispose();
        configSub?.dispose();
    };
});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

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
            {#if activeView.type === 'diff'}
                {#key activeView.title}
                    <PierreDiffViewer
                        filename={activeView.title}
                        theme={activeTheme}
                        {originalContent}
                        {modifiedContent}
                        fileStatus={activeView.resourceState?.status}
                        isWorkingCopy={activeView.resourceState
                            ? isWorkingCopyRevision(
                                  activeView.resourceState.revision,
                                  currentSnapshot?.currentEntry?.change_id
                              )
                            : activeView.rightUri?.scheme === 'file'}
                        isConflict={activeView.resourceState?.status === 'conflicted' ||
                            (activeView.resourceState?.contextValue?.toLowerCase().includes('allowopenmergeeditor') ?? false)}
                        onSave={handleSaveFile}
                        onDiscard={handleDiscardFile}
                        onResolveConflict={handleResolveConflict}
                    />
                {/key}
            {:else if activeView.type === 'multi-diff'}
                {#key activeView.title}
                    <PierreMultiDiffViewer
                        title={activeView.title}
                        files={activeView.files}
                        theme={activeTheme}
                    />
                {/key}
            {:else if activeView.type === 'commit-details' && commitDetailsBridge}
                <CommitDetailsView
                    transport={commitDetailsBridge.transport}
                    onClose={() => {
                        activeView = { type: 'empty' };
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

{#if isSettingsOpen && webHostEnv}
    <SettingsModal
        {webHostEnv}
        onClose={() => {
            isSettingsOpen = false;
        }}
    />
{/if}

<QuickInput service={activeQuickInput} />
<NotificationContainer service={activeNotifications} />

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
