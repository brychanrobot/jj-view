/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { CommitDetailsController } from '../../../src/core/controllers/commit-details-controller';
import type { HostOpenOptions } from '../../../src/core/host/host-environment';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import type { JjEditFsService } from '../../../src/core/jj-edit-fs-service';
import type { JjStatusEntry } from '../../../src/core/jj-types';
import type { JjViewFsService } from '../../../src/core/jj-view-fs-service';
import type { ScmModel, ScmSnapshot } from '../../../src/core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../../src/core/scm-resource-state';
import { getRevisionFromUri, isWorkingCopyRevision, type Uri } from '../../../src/core/uri-utils';
import { OutputChannel } from '../../../src/utils/output-channel';
import { createInMemoryBridge, type InMemoryBridge } from '../bridge/in-memory-bridge';
import { getImageMimeType, uint8ArrayToDataUrl } from '../diff/binary-detection';
import type { WebHostEnvironment } from '../host/web-host-environment';
import { parseConflictMarkersFallback } from '../merge/three-way-merge';
import type { NotificationService } from '../notifications/notification-service';
import type { WebOutputChannel } from '../output/web-output-channel';
import { getTabId, type TabEntry, type TabReorderPosition, type TabViewData } from '../tabs/tab-types';

export interface TabDocumentManagerDeps {
    webHostEnv: WebHostEnvironment | undefined;
    notificationService: NotificationService;
    fsEditService: JjEditFsService | undefined;
    fsViewService: JjViewFsService | undefined;
    remoteHostSystem: RemoteHostSystem | undefined;
    resolveScmModelForUri: (uri?: Uri) => ScmModel | undefined;
    getCurrentSnapshot: () => ScmSnapshot | undefined;
    getWorkspaceRoot: () => string;
    openFileDiffForChange: (
        file: JjStatusEntry,
        changeId: string,
        isWorkingCopy: boolean,
        options: HostOpenOptions,
        isImmutable?: boolean,
    ) => Promise<void>;
    handleAction: (commandId: string, payload?: unknown) => Promise<void>;
    outputChannel?: WebOutputChannel;
}

export interface CommitDetailsSession {
    readonly bridge: InMemoryBridge;
    readonly controller: CommitDetailsController;
    disposed: boolean;
    dispose(): void;
}

export class TabDocumentManager {
    tabs = $state<TabEntry[]>([]);
    activeTabId = $state<string | undefined>();
    activeTabSelection = $state<{ startLine: number; endLine: number }[] | undefined>(undefined);
    commitDetailsSessions = new SvelteMap<string, CommitDetailsSession>();
    documentReloadGeneration = 0;

    constructor(readonly deps: TabDocumentManagerDeps) {}

    get activeTab(): TabEntry | undefined {
        return this.tabs.find((t) => t.id === this.activeTabId);
    }

    get activeCommitDetailsSession(): CommitDetailsSession | undefined {
        return this.activeTab ? this.commitDetailsSessions.get(this.activeTab.id) : undefined;
    }

    ensureCommitDetailsSession(tab: TabEntry): void {
        if (tab.view.type !== 'commit-details') {
            return;
        }
        const model = this.deps.resolveScmModelForUri();
        const hostEnv = this.deps.webHostEnv;
        if (!model || !hostEnv) {
            return;
        }
        const tabId = tab.id;
        const changeId = tab.view.changeId;
        untrack(() => {
            if (this.commitDetailsSessions.has(tabId)) {
                return;
            }
            const logger = this.deps.outputChannel
                ? new OutputChannel(this.deps.outputChannel, 'CommitDetails')
                : undefined;
            const controller = new CommitDetailsController(changeId, model.repo, hostEnv, {
                logger,
                openDiff: async ({ file, changeId: cId, isImmutable, isWorkingCopy }) => {
                    await this.deps.openFileDiffForChange(
                        file,
                        cId,
                        isWorkingCopy ?? false,
                        { preview: true },
                        isImmutable,
                    );
                },
            });
            // An edited draft pins the tab, like a dirty file editor, so clicking
            // another commit opens a fresh preview instead of discarding the text.
            const syncDirty = (): void => {
                const liveTab = this.tabs.find((t) => t.id === tabId);
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
                model.repo.onDidStatusChange(() => {
                    void controller.load();
                }),
            ];
            void controller.load();
            const session: CommitDetailsSession = {
                bridge,
                controller,
                disposed: false,
                dispose: () => {
                    session.disposed = true;
                    for (const subscription of subscriptions) {
                        subscription.dispose();
                    }
                    controller.dispose();
                },
            };
            this.commitDetailsSessions.set(tabId, session);
        });
    }

    openOrActivateTab(view: TabViewData, options?: HostOpenOptions): void {
        const tabId = getTabId(view);
        const existingIndex = this.tabs.findIndex((t) => t.id === tabId);

        if (existingIndex >= 0) {
            this.activeTabId = tabId;
            const existingTab = this.tabs[existingIndex];
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
            const previewIndex = this.tabs.findIndex((t) => t.preview && !t.isDirty);
            if (previewIndex >= 0) {
                this.tabs[previewIndex] = newTab;
                this.activeTabId = newTab.id;
                this.ensureCommitDetailsSession(this.tabs[previewIndex]);
                return;
            }
        }

        this.tabs.push(newTab);
        this.activeTabId = newTab.id;
        this.ensureCommitDetailsSession(this.tabs[this.tabs.length - 1]);
    }

    closeTabById(tabId: string): void {
        const session = this.commitDetailsSessions.get(tabId);
        if (session) {
            session.dispose();
            this.commitDetailsSessions.delete(tabId);
        }
        const index = this.tabs.findIndex((t) => t.id === tabId);
        if (index === -1) {
            return;
        }

        this.tabs.splice(index, 1);

        if (this.activeTabId === tabId) {
            if (this.tabs.length === 0) {
                this.activeTabId = undefined;
            } else {
                const nextIndex = Math.min(index, this.tabs.length - 1);
                this.activeTabId = this.tabs[nextIndex].id;
            }
        }
    }

    closeTabByUri(uri: Uri): void {
        const uriStr = uri.toString();
        const toClose = this.tabs.filter((t) => {
            if (t.view.type === 'diff') {
                return t.view.rightUri?.toString() === uriStr || t.view.leftUri?.toString() === uriStr;
            }
            if (t.view.type === 'file' || t.view.type === 'merge') {
                return t.view.uri.toString() === uriStr;
            }
            return false;
        });
        for (const t of toClose) {
            this.closeTabById(t.id);
        }
    }

    closeOtherTabs(targetTabId: string): void {
        if (!this.tabs.some((t) => t.id === targetTabId)) {
            return;
        }
        for (const [id, session] of this.commitDetailsSessions) {
            if (id !== targetTabId) {
                session.dispose();
                this.commitDetailsSessions.delete(id);
            }
        }
        this.tabs = this.tabs.filter((t) => t.id === targetTabId);
        this.activeTabId = targetTabId;
    }

    closeTabsToTheRight(targetTabId: string): void {
        const idx = this.tabs.findIndex((t) => t.id === targetTabId);
        if (idx === -1) {
            return;
        }
        const toRemove = this.tabs.slice(idx + 1);
        for (const tab of toRemove) {
            const session = this.commitDetailsSessions.get(tab.id);
            if (session) {
                session.dispose();
                this.commitDetailsSessions.delete(tab.id);
            }
        }
        this.tabs = this.tabs.slice(0, idx + 1);
        if (!this.tabs.some((t) => t.id === this.activeTabId)) {
            this.activeTabId = targetTabId;
        }
    }

    closeAllTabs(): void {
        for (const session of this.commitDetailsSessions.values()) {
            session.dispose();
        }
        this.commitDetailsSessions.clear();
        this.tabs = [];
        this.activeTabId = undefined;
    }

    pinTab(tabId: string): void {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (tab) {
            tab.preview = false;
        }
    }

    handleReorderTabs(sourceTabId: string, targetTabId: string, position: TabReorderPosition): void {
        const sourceIndex = this.tabs.findIndex((t) => t.id === sourceTabId);
        const targetIndex = this.tabs.findIndex((t) => t.id === targetTabId);
        if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
            return;
        }

        const [movedTab] = this.tabs.splice(sourceIndex, 1);
        const newTargetIndex = this.tabs.findIndex((t) => t.id === targetTabId);
        const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
        this.tabs.splice(insertIndex, 0, movedTab);
    }

    openCommentsTab(): void {
        this.openOrActivateTab({ type: 'comments' }, { preview: false });
    }

    openOutputTab(): void {
        this.openOrActivateTab({ type: 'output' }, { preview: false });
    }

    openProcessMonitorTab(): void {
        this.openOrActivateTab({ type: 'process-monitor' }, { preview: false });
    }

    async resolveUriContent(uri?: Uri): Promise<string> {
        if (!uri) {
            return '';
        }
        const start = performance.now();
        const uriPath = uri.path || uri.fsPath || '';
        const imageMimeType = getImageMimeType(uriPath);
        let content = '';
        if (imageMimeType) {
            let bytes: Uint8Array = new Uint8Array(0);
            try {
                if (uri.scheme === 'file' && this.deps.remoteHostSystem) {
                    bytes = await this.deps.remoteHostSystem.fs.readBinaryFile(uri.fsPath);
                } else if (uri.scheme === 'jj-view' && this.deps.fsViewService) {
                    bytes = await this.deps.fsViewService.readFile(uri);
                } else if (uri.scheme === 'jj-edit' && this.deps.fsEditService) {
                    bytes = await this.deps.fsEditService.readFile(uri);
                }
            } catch {
                bytes = new Uint8Array(0);
            }
            content = uint8ArrayToDataUrl(bytes, imageMimeType);
        } else if (uri.scheme === 'file' && this.deps.remoteHostSystem) {
            content = await this.deps.remoteHostSystem.fs.readTextFile(uri.fsPath);
        } else if (uri.scheme === 'jj-view' && this.deps.fsViewService) {
            const bytes = await this.deps.fsViewService.readFile(uri);
            content = new TextDecoder().decode(bytes);
        } else if (uri.scheme === 'jj-edit' && this.deps.fsEditService) {
            const bytes = await this.deps.fsEditService.readFile(uri);
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

    async loadDiffFromUris(
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
        const existingTab = this.tabs.find((t) => t.id === tabId);
        if (
            existingTab &&
            existingTab.view.type === 'diff' &&
            (existingTab.view.loaded ||
                existingTab.isDirty ||
                existingTab.view.originalContent ||
                existingTab.view.modifiedContent)
        ) {
            this.activeTabId = tabId;
            if (options?.preview === false && existingTab.preview) {
                existingTab.preview = false;
            }
            return;
        }

        this.openOrActivateTab(
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
            const [leftText, rightText] = await Promise.all([
                this.resolveUriContent(leftUri),
                this.resolveUriContent(rightUri),
            ]);
            const targetTab = this.tabs.find((t) => t.id === tabId);
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

    async loadDiffContents(state: JjResourceState, options?: HostOpenOptions): Promise<void> {
        await this.loadDiffFromUris(
            state.leftUri,
            state.rightUri,
            state.diffTitle || state.resourceUri.fsPath,
            state,
            options,
        );
    }

    async reloadOpenDocumentTabs(): Promise<void> {
        const generation = ++this.documentReloadGeneration;
        const reloads: Promise<void>[] = [];
        for (const tab of this.tabs) {
            const tabId = tab.id;
            if (tab.view.type === 'diff' && tab.view.loaded) {
                const { leftUri, rightUri } = tab.view;
                reloads.push(
                    (async () => {
                        const [leftText, rightText] = await Promise.all([
                            this.resolveUriContent(leftUri),
                            this.resolveUriContent(rightUri),
                        ]);
                        if (generation !== this.documentReloadGeneration) {
                            return;
                        }
                        const target = this.tabs.find((t) => t.id === tabId);
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
                        const content = await this.resolveUriContent(uri);
                        if (generation !== this.documentReloadGeneration) {
                            return;
                        }
                        const target = this.tabs.find((t) => t.id === tabId);
                        if (
                            !target ||
                            target.view.type !== 'file' ||
                            target.isDirty ||
                            target.view.content === content
                        ) {
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
                                    this.resolveUriContent(file.leftUri),
                                    this.resolveUriContent(file.rightUri),
                                ]);
                                return { originalContent, modifiedContent };
                            }),
                        );
                        if (generation !== this.documentReloadGeneration) {
                            return;
                        }
                        const target = this.tabs.find((t) => t.id === tabId);
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

    async loadFileFromUri(uri: Uri, options?: HostOpenOptions): Promise<void> {
        const normPath = uri.path || uri.fsPath || '';
        const cleanPath = normPath.startsWith('/') ? normPath.slice(1) : normPath;
        const fileName = cleanPath.split('/').filter(Boolean).pop() || cleanPath || 'file';

        let matchingState: JjResourceState | undefined;
        const uriRevision = uri.scheme === 'file' ? '@' : (getRevisionFromUri(uri) ?? '@');
        const snap = this.deps.getCurrentSnapshot();
        const isWc = isWorkingCopyRevision(uriRevision, snap?.currentEntry?.change_id);
        const wsRoot = this.deps.getWorkspaceRoot();
        if (isWc) {
            const change = snap?.workingCopyChanges?.find(
                (c: JjStatusEntry) => c.path === cleanPath || normPath.endsWith(c.path),
            );
            if (change) {
                matchingState = createJjResourceState(change, '@', wsRoot, {
                    squashable: snap?.parentMutable ?? false,
                    multipleAncestors: (snap?.ancestors.length ?? 0) > 1,
                    openDiffOnClick: true,
                    hasChild: snap?.hasChild ?? false,
                    workingCopyChangeId: snap?.currentEntry?.change_id,
                });
            }
        } else if (uri.scheme === 'jj-edit') {
            matchingState = createJjResourceState({ path: cleanPath, status: 'modified' }, uriRevision, wsRoot, {
                editable: true,
                openDiffOnClick: true,
                workingCopyChangeId: snap?.currentEntry?.change_id,
            });
        }

        this.openOrActivateTab(
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
            const content = await this.resolveUriContent(uri);
            const tabId = getTabId({ type: 'file', uri, title: fileName });
            const targetTab = this.tabs.find((t) => t.id === tabId);
            if (targetTab && targetTab.view.type === 'file') {
                if (!targetTab.isDirty) {
                    targetTab.view.content = content;
                }
            }
        } catch (err) {
            console.error('Failed to load file contents for file viewer:', err);
        }
    }

    async handleSaveFile(newContent: string): Promise<void> {
        const tab = this.activeTab;
        if (!tab) {
            return;
        }
        let targetUri: Uri | undefined;
        if (tab.view.type === 'diff') {
            targetUri = tab.view.rightUri;
        } else if (tab.view.type === 'file' || tab.view.type === 'merge') {
            targetUri = tab.view.uri;
        }
        if (!targetUri) {
            return;
        }
        if (targetUri.scheme === 'jj-edit' && this.deps.fsEditService) {
            await this.deps.fsEditService.writeFile(targetUri, new TextEncoder().encode(newContent));
        } else if (this.deps.remoteHostSystem) {
            await this.deps.remoteHostSystem.fs.writeTextFile(targetUri.fsPath, newContent);
        }
        if (tab.view.type === 'diff') {
            tab.view.modifiedContent = newContent;
        } else if (tab.view.type === 'file') {
            tab.view.content = newContent;
        } else if (tab.view.type === 'merge') {
            tab.view.resolvedContent = newContent;
        }
        tab.isDirty = false;
        this.deps.webHostEnv?.documents.notifyDidSaveDocument(targetUri);
        const targetScm = this.deps.resolveScmModelForUri(targetUri);
        if (targetScm) {
            await targetScm.refresh({ reason: 'save-file' });
        }
    }

    async saveUriIfDirty(uri: Uri): Promise<void> {
        const uriStr = uri.toString();
        const targetTab = this.tabs.find(
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
                if (targetUri.scheme === 'jj-edit' && this.deps.fsEditService) {
                    await this.deps.fsEditService.writeFile(targetUri, new TextEncoder().encode(content));
                } else if (this.deps.remoteHostSystem) {
                    await this.deps.remoteHostSystem.fs.writeTextFile(targetUri.fsPath, content);
                }
                targetTab.isDirty = false;
                this.deps.webHostEnv?.documents.notifyDidSaveDocument(targetUri);
                const targetScm = this.deps.resolveScmModelForUri(targetUri);
                if (targetScm) {
                    await targetScm.refresh({ reason: 'save-file' });
                }
            }
        }
    }

    async handleDiscardFile(): Promise<void> {
        const tab = this.activeTab;
        if (!tab) {
            return;
        }
        if (tab.view.type === 'diff' && tab.view.resourceState) {
            const state = tab.view.resourceState;
            await this.deps.handleAction('jj-view.restore', state);
            const targetScm = this.deps.resolveScmModelForUri(state.resourceUri);
            if (targetScm) {
                await targetScm.refresh({ reason: 'discard-file' });
            }
            this.closeTabById(tab.id);
            return;
        }
        if (tab.view.type === 'file') {
            if (tab.view.resourceState) {
                await this.deps.handleAction('jj-view.restore', tab.view.resourceState);
                const targetScm = this.deps.resolveScmModelForUri(tab.view.resourceState.resourceUri);
                if (targetScm) {
                    await targetScm.refresh({ reason: 'discard-file' });
                }
            } else if (tab.view.uri.scheme === 'file' || tab.view.uri.scheme === 'jj-edit') {
                const content = await this.resolveUriContent(tab.view.uri);
                tab.view.content = content;
            }
            tab.isDirty = false;
            this.closeTabById(tab.id);
        }
    }

    async handleResolveConflict(): Promise<void> {
        const tab = this.activeTab;
        if (!tab || tab.view.type !== 'diff' || !tab.view.resourceState) {
            return;
        }
        const targetScm = this.deps.resolveScmModelForUri(tab.view.resourceState.resourceUri);
        if (targetScm) {
            await targetScm.refresh({ reason: 'resolve-conflict' });
        }
        await this.loadDiffContents(tab.view.resourceState, { preview: false });
    }

    async loadConflictPartsForResource(
        conflictPath: string,
        uri: Uri,
    ): Promise<{ base: string; left: string; right: string }> {
        const targetScm = this.deps.resolveScmModelForUri(uri);
        if (targetScm) {
            try {
                return await targetScm.jj.getConflictParts(conflictPath);
            } catch {
                // Fall through to conflict marker fallback parser if jj resolve capture fails
            }
        }
        const rawContent = await this.resolveUriContent(uri);
        const parsed = parseConflictMarkersFallback(rawContent);
        if (parsed) {
            return parsed;
        }
        return { base: rawContent, left: rawContent, right: rawContent };
    }

    async openMergeEditorForResource(state: JjResourceState, options?: HostOpenOptions): Promise<void> {
        const uri = state.resourceUri;
        const normPath = state.relativePath || uri.path || uri.fsPath || '';
        const cleanPath = normPath.startsWith('/') ? normPath.slice(1) : normPath;
        const targetScm = this.deps.resolveScmModelForUri(uri);
        const targetSnap = targetScm?.snapshot ?? this.deps.getCurrentSnapshot();
        const conflictPath =
            targetSnap?.conflictedPaths.find((p: string) => p === cleanPath || normPath.endsWith(p)) || cleanPath;
        const fileName = conflictPath.split('/').filter(Boolean).pop() || conflictPath || 'Merge';
        const mergeTitle = `${fileName} (Merge)`;

        this.openOrActivateTab(
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
            const parts = await this.loadConflictPartsForResource(conflictPath, uri);
            const tabId = getTabId({
                type: 'merge',
                uri,
                title: mergeTitle,
                baseContent: '',
                leftContent: '',
                rightContent: '',
            });
            const targetTab = this.tabs.find((t) => t.id === tabId);
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

    async handleCompleteMerge(resolvedContent: string): Promise<void> {
        const tab = this.activeTab;
        if (!tab || tab.view.type !== 'merge') {
            return;
        }
        const targetUri = tab.view.uri;
        const closingTabId = tab.id;
        if (targetUri.scheme === 'jj-edit' && this.deps.fsEditService) {
            await this.deps.fsEditService.writeFile(targetUri, new TextEncoder().encode(resolvedContent));
        } else if (this.deps.remoteHostSystem) {
            await this.deps.remoteHostSystem.fs.writeTextFile(targetUri.fsPath, resolvedContent);
        }
        tab.isDirty = false;
        this.deps.webHostEnv?.documents.notifyDidSaveDocument(targetUri);
        const targetScm = this.deps.resolveScmModelForUri(targetUri);
        if (targetScm) {
            await targetScm.refresh({ reason: 'complete-merge' });
        }
        this.closeTabById(closingTabId);
    }

    syncCommitDetailsSessions(): void {
        const liveIds = new Set<string>();
        for (const tab of this.tabs) {
            if (tab.view.type === 'commit-details') {
                liveIds.add(tab.id);
                this.ensureCommitDetailsSession(tab);
            }
        }
        untrack(() => {
            for (const [tabId, session] of this.commitDetailsSessions) {
                if (liveIds.has(tabId)) {
                    continue;
                }
                session.dispose();
                this.commitDetailsSessions.delete(tabId);
            }
        });
    }

    disposeCommitDetailsSessions(): void {
        for (const session of this.commitDetailsSessions.values()) {
            session.dispose();
        }
        this.commitDetailsSessions.clear();
    }
}
