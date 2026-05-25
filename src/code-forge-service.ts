/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { ChangeStatusRequest, CodeForgeProvider } from './code-forge-provider';
import type { CodeForgeRegistry } from './code-forge-registry';
import type { JjService } from './jj-service';
import type { CodeForgeChangeInfo, CommitParent, JjLogEntry } from './jj-types';
import { TimerBucket } from './utils/timer-bucket';

export class CodeForgeService implements vscode.Disposable {
    private poller: NodeJS.Timeout | undefined;
    private activeProviderDisposable: vscode.Disposable | undefined;
    private disposables: vscode.Disposable[] = [];
    private isDisposed = false;
    private backoffTimers = new TimerBucket();
    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    private _initPromise: Promise<void>;
    private lastRefreshTime: number = 0;
    private lastDetectionTime = 0;
    private detectPromise: Promise<void> | undefined;

    constructor(
        private workspaceRoot: string,
        private jjService: JjService,
        private registry: CodeForgeRegistry,
        private outputChannel?: vscode.OutputChannel,
    ) {
        this.disposables.push(
            this.registry.onDidActiveProviderChange((provider) => {
                this.activeProviderDisposable?.dispose();
                if (provider) {
                    this.activeProviderDisposable = provider.onDidUpdate(() => {
                        this._onDidUpdate.fire();
                    });
                } else {
                    this.activeProviderDisposable = undefined;
                }
                this._onDidUpdate.fire();
            }),
        );

        this._initPromise = this.detectActiveProvider(true);

        // Listen for config changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
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

        // Refresh when window gains focus (throttled to 10s)
        this.disposables.push(
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused && this.isEnabled) {
                    const now = Date.now();
                    if (now - this.lastRefreshTime > 10000) {
                        this.forceRefresh();
                    }
                }
            }),
        );
    }

    public async awaitReady(): Promise<void> {
        return this._initPromise;
    }

    public dispose() {
        this.isDisposed = true;
        this.stopPolling();
        this.backoffTimers.dispose();
        this.activeProviderDisposable?.dispose();
        for (const disposable of this.disposables) {
            disposable?.dispose();
        }
        this._onDidUpdate.dispose();
    }

    public get isEnabled(): boolean {
        return !!this.registry.getActive();
    }

    public get activeProvider(): CodeForgeProvider | undefined {
        return this.registry.getActive();
    }

    public startPolling() {
        if (this.poller) {
            return;
        }

        this.poller = setInterval(() => {
            if (this.isEnabled && vscode.window.state.focused) {
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
        const activeProvider = this.registry.getActive();
        if (activeProvider) {
            this.outputChannel?.appendLine(`[CodeForgeService] Force refresh triggered`);
            activeProvider.clearCache();
            this.lastRefreshTime = Date.now();
        }
    }

    public requestRefreshWithBackoffs(): void {
        if (!this.isEnabled) {
            return;
        }

        // Cancel any previous backoff wave before starting a new one.
        this.backoffTimers.dispose();

        const delays = [2000, 3000, 5000, 10000];
        this.outputChannel?.appendLine(`[CodeForgeService] Scheduling backoff refreshes: ${delays.join(', ')}ms`);

        for (const delay of delays) {
            this.backoffTimers.schedule(() => this.forceRefresh(), delay);
        }
    }

    public async detectActiveProvider(force = false): Promise<void> {
        if (!force && this.registry.getActive()) {
            return;
        }

        const now = Date.now();
        if (!force && now - this.lastDetectionTime < 30000) {
            return;
        }

        if (this.detectPromise) {
            return this.detectPromise;
        }

        this.detectPromise = (async () => {
            this.lastDetectionTime = now;
            try {
                const remotes = await this.jjService.getGitRemotes();
                await this.registry.autoDetect(this.workspaceRoot, remotes);
            } catch (e) {
                this.outputChannel?.appendLine(`[CodeForgeService] Failed to detect active provider: ${e}`);
            }
        })();

        try {
            await this.detectPromise;
        } finally {
            this.detectPromise = undefined;
        }
    }

    public async ensureFreshStatuses(changes: ChangeStatusRequest[]): Promise<boolean> {
        const activeProvider = this.registry.getActive();
        if (!activeProvider) {
            return false;
        }
        return activeProvider.fetchStatuses(changes);
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
            const parentBookmarks = parentCommit?.bookmarks?.filter((b) => !b.remote).map((b) => b.name);
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
        const activeProvider = this.registry.getActive();
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
                    commit.bookmarks?.filter((b) => !b.remote).map((b) => b.name),
                );
                if (info) {
                    commit.codeForgeChange = info;
                }
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
                    this.outputChannel?.appendLine(
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
                        this.outputChannel?.appendLine(
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
