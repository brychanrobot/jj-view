/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoggerChannel } from '../utils/output-channel';
import { TimerBucket } from '../utils/timer-bucket';
import type { ChangeStatusRequest, CodeForgeProvider } from './code-forge-provider';
import type { CodeForgeProviderFactory } from './code-forge-provider-factory';
import type { CodeForgeRegistry } from './code-forge-registry';
import { type Disposable, disposeSafely, type Event, EventEmitter } from './host/events';
import type { HostDisposable, HostEnvironment } from './host/host-environment';
import type { JjService } from './jj-service';
import type { CodeForgeChangeInfo, CommitParent, JjLogEntry } from './jj-types';

const DEFAULT_PRIORITY_ORDER = ['github', 'gitlab', 'gerrit'];

function getProviderPriority(provider: CodeForgeProvider): number {
    if (provider.priority !== undefined) {
        return provider.priority;
    }
    const idx = DEFAULT_PRIORITY_ORDER.indexOf(provider.id);
    return idx === -1 ? DEFAULT_PRIORITY_ORDER.length : idx;
}

export class CodeForgeService implements Disposable {
    private poller: NodeJS.Timeout | undefined;
    private activeProviderDisposable: Disposable | undefined;
    private disposables: (Disposable | HostDisposable)[] = [];
    private isDisposed = false;
    private backoffTimers = new TimerBucket();
    private _onDidUpdate = new EventEmitter<void>();
    public readonly onDidUpdate: Event<void> = this._onDidUpdate.event;

    private _onRequestRefresh = new EventEmitter<void>();
    public readonly onRequestRefresh: Event<void> = this._onRequestRefresh.event;

    private _onDidActiveProviderChange = new EventEmitter<CodeForgeProvider | undefined>();
    public readonly onDidActiveProviderChange: Event<CodeForgeProvider | undefined> =
        this._onDidActiveProviderChange.event;

    private _initPromise: Promise<void>;
    private lastRefreshTime: number = 0;
    private lastDetectionTime = 0;
    private detectPromise: Promise<boolean> | undefined;

    private providers = new Map<string, CodeForgeProvider>();
    private activeProviderInstance: CodeForgeProvider | undefined;

    constructor(
        public readonly workspaceRoot: string,
        private jjService: JjService,
        private registry: CodeForgeRegistry,
        private host: HostEnvironment,
        private outputChannel: LoggerChannel,
    ) {
        for (const factory of this.registry.getFactories()) {
            this.providers.set(factory.id, factory.create(this.outputChannel, this.host));
        }

        this.disposables.push(
            this.registry.onDidRegisterFactory((factory: CodeForgeProviderFactory) => {
                if (!this.providers.has(factory.id)) {
                    this.providers.set(factory.id, factory.create(this.outputChannel, this.host));
                    this.detectActiveProvider(true);
                }
            }),
        );

        this._initPromise = this.detectActiveProvider(true).then(() => {});

        // Listen for config changes
        if (this.host.config.onDidChangeConfiguration) {
            this.disposables.push(
                this.host.config.onDidChangeConfiguration((e) => {
                    if (
                        e.affectsConfiguration('jj-view.gerrit') ||
                        e.affectsConfiguration('jj-view.github') ||
                        e.affectsConfiguration('jj-view.gitlab') ||
                        e.affectsConfiguration('jj-view.codeForge')
                    ) {
                        this.detectActiveProvider(true);
                    }
                }),
            );
        }

        // Refresh when window gains focus (throttled to 10s)
        if (this.host.ui.onDidChangeFocus) {
            this.disposables.push(
                this.host.ui.onDidChangeFocus((focused) => {
                    if (focused && this.isEnabled) {
                        const now = Date.now();
                        if (now - this.lastRefreshTime > 10000) {
                            this.forceRefresh();
                        }
                    }
                }),
            );
        }
    }

    public async awaitReady(): Promise<void> {
        return this._initPromise;
    }

    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        this.stopPolling();
        this.safeDispose(this.backoffTimers, 'backoff timers');
        this.safeDispose(this.activeProviderDisposable, 'active provider');
        this.safeDeactivate(this.activeProviderInstance);
        for (const provider of this.providers.values()) {
            if (typeof provider.dispose === 'function') {
                const disposeFn = provider.dispose.bind(provider);
                this.safeDispose({ dispose: disposeFn }, `provider ${provider.id}`);
            }
        }
        this.providers.clear();
        for (const disposable of this.disposables) {
            this.safeDispose(disposable, 'subscription');
        }
        this.disposables = [];
        this.safeDispose(this._onDidActiveProviderChange, 'active provider change emitter');
        this.safeDispose(this._onDidUpdate, 'update emitter');
        this.safeDispose(this._onRequestRefresh, 'request refresh emitter');
        this.activeProviderDisposable = undefined;
        this.activeProviderInstance = undefined;
    }

    private safeDispose(disposable: Disposable | undefined, description: string): void {
        disposeSafely(disposable, (err) => {
            this.outputChannel.error(`[CodeForgeService] Error disposing ${description}: ${err}`);
        });
    }

    private safeDeactivate(provider: CodeForgeProvider | undefined): void {
        if (!provider) {
            return;
        }
        try {
            provider.deactivate();
        } catch (err) {
            this.outputChannel.error(`[CodeForgeService] Error deactivating active provider: ${err}`);
        }
    }

    public get isEnabled(): boolean {
        return !!this.activeProviderInstance;
    }

    public get activeProvider(): CodeForgeProvider | undefined {
        return this.activeProviderInstance;
    }

    public getProvider(id: string): CodeForgeProvider | undefined {
        return this.providers.get(id);
    }

    public startPolling() {
        if (this.poller) {
            return;
        }

        this.poller = setInterval(() => {
            const isFocused = this.host.ui.isFocused ?? true;
            if (this.isEnabled && isFocused) {
                this.forceRefresh();
            }
        }, 60000);
    }

    public stopPolling() {
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = undefined;
        }
    }

    public forceRefresh() {
        if (this.isDisposed) {
            return;
        }
        if (this.activeProviderInstance) {
            this.outputChannel.info(`[CodeForgeService] Force refresh triggered`);
            this.lastRefreshTime = Date.now();
            this._onRequestRefresh.fire();
        }
    }

    public requestRefreshWithBackoffs(): void {
        if (!this.isEnabled) {
            return;
        }

        // Cancel any previous backoff wave before starting a new one.
        this.backoffTimers.dispose();

        const delays = [2000, 3000, 5000, 10000];
        this.outputChannel.info(`[CodeForgeService] Scheduling backoff refreshes: ${delays.join(', ')}ms`);

        for (const delay of delays) {
            this.backoffTimers.schedule(() => this.forceRefresh(), delay);
        }
    }

    public async detectActiveProvider(force = false): Promise<boolean> {
        if (this.detectPromise) {
            return this.detectPromise;
        }

        if (!force && this.activeProviderInstance) {
            return false;
        }

        const now = Date.now();
        if (!force && now - this.lastDetectionTime < 30000) {
            return false;
        }

        this.lastDetectionTime = now;
        this.detectPromise = this.doDetectActiveProvider();

        try {
            return await this.detectPromise;
        } finally {
            this.detectPromise = undefined;
        }
    }

    private async doDetectActiveProvider(): Promise<boolean> {
        try {
            const remotes = await this.jjService.getGitRemotes();
            const repoRoot = await this.jjService.getRepoRoot();
            const preferredId = this.host.config.get<string>('codeForge.provider');

            let detectedProvider: CodeForgeProvider | undefined;

            if (preferredId) {
                const provider = this.providers.get(preferredId);
                if (provider && (await provider.detect(repoRoot, remotes))) {
                    detectedProvider = provider;
                }
            }

            if (!detectedProvider) {
                const sortedProviders = Array.from(this.providers.values()).sort(
                    (a, b) => getProviderPriority(a) - getProviderPriority(b),
                );

                for (const provider of sortedProviders) {
                    if (await provider.detect(repoRoot, remotes)) {
                        detectedProvider = provider;
                        break;
                    }
                }
            }

            const prevActive = this.activeProviderInstance;
            const changed = prevActive?.id !== detectedProvider?.id;
            if (changed) {
                this.activeProviderDisposable?.dispose();
                prevActive?.deactivate();

                this.activeProviderInstance = detectedProvider;

                if (detectedProvider) {
                    detectedProvider.activate();
                    this.activeProviderDisposable = detectedProvider.onDidUpdate(() => {
                        this._onDidUpdate.fire();
                    });
                } else {
                    this.activeProviderDisposable = undefined;
                }

                this._onDidActiveProviderChange.fire(detectedProvider);
                this._onDidUpdate.fire();
                if (detectedProvider) {
                    this._onRequestRefresh.fire();
                }
            }
            return changed;
        } catch (e) {
            this.outputChannel.error(`[CodeForgeService] Failed to detect active provider: ${e}`);
            return false;
        }
    }

    public async ensureFreshStatuses(changes: ChangeStatusRequest[]): Promise<boolean> {
        if (!this.activeProviderInstance) {
            return false;
        }
        return this.activeProviderInstance.fetchStatuses(changes, this.jjService);
    }

    private verifyStructureSync(
        parents: CommitParent[],
        info: CodeForgeChangeInfo,
        activeProvider: CodeForgeProvider,
        commitMap: Map<string, JjLogEntry>,
    ): void {
        if (info.status !== 'NEW') {
            return;
        }

        const remoteParents = info.remoteParents;
        if (!remoteParents || remoteParents.length === 0) {
            info.parentSynced = true;
            return;
        }

        if (remoteParents.length !== parents.length) {
            info.parentSynced = false;
            return;
        }

        const remoteSet = new Set(remoteParents);
        const matches = parents.every((localParent) => {
            const parentCommit = commitMap.get(localParent.commit_id);
            const parentBookmarks = parentCommit
                ? (parentCommit.bookmarks ?? []).filter((b) => !b.remote).map((b) => b.name)
                : undefined;
            const parentInfo = activeProvider.getCachedChangeInfo(
                localParent.change_id,
                parentCommit?.description,
                parentBookmarks,
            );
            if (!parentInfo) {
                return localParent.is_immutable && remoteSet.has(localParent.commit_id);
            }
            return parentInfo.currentRevision !== undefined && remoteSet.has(parentInfo.currentRevision);
        });

        info.parentSynced = matches;
    }

    public populateCodeForgeInfo(commits: JjLogEntry[]): void {
        const activeProvider = this.activeProviderInstance;
        if (!activeProvider) {
            return;
        }

        const commitMap = new Map<string, JjLogEntry>();
        for (const commit of commits) {
            if (commit.commit_id) {
                commitMap.set(commit.commit_id, commit);
                const info = activeProvider.getCachedChangeInfo(
                    commit.change_id,
                    commit.description,
                    (commit.bookmarks ?? []).filter((b) => !b.remote).map((b) => b.name),
                );
                commit.codeForgeChange = info ?? undefined;
            }
        }

        // Structural Pass
        for (const commit of commits) {
            const info = commit.codeForgeChange;
            if (info && commit.parents) {
                this.verifyStructureSync(commit.parents, info, activeProvider, commitMap);
                info.synced = info.contentSynced && info.parentSynced;
            }
        }

        const needsUploadCache = new Map<string, boolean>();
        const computeNeedsUpload = (commitId: string): boolean => {
            const cached = needsUploadCache.get(commitId);
            if (cached !== undefined) {
                return cached;
            }

            const commit = commitMap.get(commitId);
            if (!commit) {
                return false;
            }

            let needsUpload = false;
            const info = commit.codeForgeChange;
            if (info && info.status === 'NEW') {
                const idMatches = info.currentRevision === commit.commit_id;
                const contentSynced = info.contentSynced === true;
                const parentSynced = info.parentSynced !== false;

                if (!(idMatches || (contentSynced && parentSynced))) {
                    needsUpload = true;
                    this.outputChannel.info(
                        `[CodeForgeService] Commit ${commit.change_id.substring(0, 8)} needs upload: ` +
                            `idMatches=${idMatches}, contentSynced=${contentSynced}, parentSynced=${parentSynced} ` +
                            `(currentRevision=${info.currentRevision?.substring(0, 8)}, commitId=${commit.commit_id?.substring(0, 8)})`,
                    );
                }
            }

            if (!needsUpload && commit.parents) {
                for (const parent of commit.parents) {
                    if (computeNeedsUpload(parent.commit_id)) {
                        needsUpload = true;
                        this.outputChannel.info(
                            `[CodeForgeService] Commit ${commit.change_id.substring(0, 8)} needs upload: inherited from parent ${parent.commit_id.substring(0, 8)}`,
                        );
                        break;
                    }
                }
            }

            needsUploadCache.set(commitId, needsUpload);
            return needsUpload;
        };

        for (const commit of commits) {
            if (commit.commit_id && commit.codeForgeChange && commit.codeForgeChange.status === 'NEW') {
                const needsUpload = computeNeedsUpload(commit.commit_id);
                commit.codeForgeNeedsUpload = needsUpload;
            }
        }
    }
}
