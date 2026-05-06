/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from './jj-service';
import type { CommitParent, GerritClInfo } from './jj-types';
import { chunkArray } from './utils/array-utils';
import { convertJjChangeIdToHex } from './utils/jj-utils';

interface GerritFile {
    status?: string;
    new_sha?: string;
}

export interface GerritRevision {
    files?: Record<string, GerritFile>;
    commit?: {
        message: string;
        parents?: { commit: string }[];
    };
}

export interface GerritChange {
    change_id: string;
    _number: number;
    status: 'NEW' | 'MERGED' | 'ABANDONED';
    submittable: boolean;
    unresolved_comment_count?: number;
    current_revision?: string;
    revisions?: Record<string, GerritRevision>;
    project?: string;
    branch?: string;
    subject?: string;
    created?: string;
    updated?: string;
    mergeable?: boolean;
    insertions?: number;
    deletions?: number;
    owner?: { _account_id: number };
    labels?: Record<string, unknown>;
}

export class GerritService implements vscode.Disposable {
    private static readonly TRAILER_REGEXES = [
        /^Change-Id: (I[0-9a-fA-F]{40})\s*$/m,
        /^Link: .*\/\+\/(\d+)(?:\/\d+)?\/?\s*$/m,
        /^Link: .*\/(\d+)\/?\s*$/m,
    ];

    private poller: NodeJS.Timeout | undefined;
    private cache: Map<string, GerritClInfo> = new Map();
    private _gerritHost: string | undefined;
    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    private _initPromise: Promise<void>;

    private lastRefreshTime: number = 0;

    constructor(
        private workspaceRoot: string,
        private jjService: JjService,
        private outputChannel?: vscode.OutputChannel, // Optional for easier testing
    ) {
        this._initPromise = this.detectGerritHost();

        // Listen for config changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('jj-view.gerrit')) {
                this.detectGerritHost();
            }
        });

        // Refresh when window gains focus (throttled to 10s)
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused && this.isEnabled) {
                const now = Date.now();
                if (now - this.lastRefreshTime > 10000) {
                    this._refresh('Window focus');
                }
            }
        });
    }

    /** For testing only: wait for initialization to complete */
    public async awaitReady(): Promise<void> {
        return this._initPromise;
    }

    dispose() {
        this.stopPolling();
        this._onDidUpdate.dispose();
    }

    public get isEnabled(): boolean {
        return !!this._gerritHost;
    }

    public startPolling() {
        if (this.poller) {
            return;
        }

        // Invalidate cache and notify listeners every 60 seconds when focused.
        // Listeners will re-fetch Gerrit data for their cached commits.
        this.poller = setInterval(() => {
            if (this.isEnabled && vscode.window.state.focused) {
                this._refresh();
            }
        }, 60000);
    }

    public stopPolling() {
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = undefined;
        }
    }

    /** Immediately clears cache and notifies listeners to re-fetch Gerrit data. */
    public forceRefresh() {
        this._refresh('Force refresh');
    }

    private _refresh(reason?: string) {
        if (this.isEnabled) {
            if (reason) {
                this.outputChannel?.appendLine(`[GerritService] ${reason} triggered`);
            }
            this.cache.clear();
            this._onDidUpdate.fire();
            this.lastRefreshTime = Date.now();
        }
    }

    /**
     * Schedules multiple force refreshes with backoff delays to catch updates (e.g. CI, Merge status)
     * that might have latency after an upload.
     */
    public requestRefreshWithBackoffs(scheduleFn: (callback: () => void, delay: number) => void = setTimeout) {
        if (!this.isEnabled) {
            return;
        }

        const delays = [2000, 3000, 5000, 10000];
        this.outputChannel?.appendLine(`[GerritService] Scheduling backoff refreshes: ${delays.join(', ')}ms`);

        for (const delay of delays) {
            scheduleFn(() => this.forceRefresh(), delay);
        }
    }

    private async detectGerritHost() {
        // 1. Check extension setting
        const config = vscode.workspace.getConfiguration('jj-view');
        const settingHost = config.get<string>('gerrit.host');

        if (settingHost) {
            this._gerritHost = settingHost.replace(/\/$/, ''); // Remove trailing slash
            return;
        }

        // 2. Check .gitreview file
        try {
            const gitreviewPath = path.join(this.workspaceRoot, '.gitreview');
            if (fs.existsSync(gitreviewPath)) {
                const content = await fs.promises.readFile(gitreviewPath, 'utf8');
                const match = content.match(/host=(.+)/);
                if (match?.[1]) {
                    let host = match[1].trim();
                    if (!host.startsWith('http')) {
                        host = `https://${host}`;
                    }
                    this._gerritHost = host.replace(/\/$/, '');
                    return;
                }
            }
        } catch (e) {
            console.error('Failed to parse .gitreview:', e);
        }

        // 3. Check git remotes via jj
        try {
            const remotes = await this.jjService.getGitRemotes();

            // Prioritize 'origin', then 'gerrit', then others
            // Find specific remotes if they exist
            const origin = remotes.find((r) => r.name === 'origin');
            const gerrit = remotes.find((r) => r.name === 'gerrit');

            // Create a sorted list based on priority
            const sortedRemotes = [];
            if (origin) {
                sortedRemotes.push(origin);
            }
            if (gerrit) {
                sortedRemotes.push(gerrit);
            }
            // Add remaining
            remotes.forEach((r) => {
                if (r.name !== 'origin' && r.name !== 'gerrit') {
                    sortedRemotes.push(r);
                }
            });

            for (const { name, url } of sortedRemotes) {
                this.outputChannel?.appendLine(`[GerritService] Checking remote '${name}' URL: '${url}'`);

                let host: string | undefined;

                if (url.includes('googlesource.com') || url.includes('/gerrit/')) {
                    host = url;
                } else if (url.startsWith('sso://')) {
                    // Handle sso://chromium/chromium/src.git -> https://chromium.googlesource.com/chromium/src.git
                    // Format: sso://<host-part>/<path>
                    // We'll treat the first segment as the subdomain for googlesource.com
                    const match = url.match(/sso:\/\/([^/]+)\/(.+)/);
                    if (match) {
                        host = `https://${match[1]}.googlesource.com/${match[2]}`;
                    }
                }

                if (host) {
                    // Handle SSH: ssh://user@host:port/path -> https://host
                    if (host.startsWith('ssh://')) {
                        const match = host.match(/ssh:\/\/([^@]+@)?([^:/]+)(:\d+)?\/(.+)/);
                        if (match) {
                            host = `https://${match[2]}`;
                        }
                    }

                    if (host.endsWith('.git')) {
                        host = host.slice(0, -4);
                    }

                    // For googlesource.com, extract origin or convert to https
                    if (host.includes('googlesource.com')) {
                        try {
                            const urlObj = new URL(host);
                            host = urlObj.origin;
                        } catch {
                            if (!host.startsWith('http')) {
                                const match = host.match(/([a-zA-Z0-9-]+\.googlesource\.com)/);
                                if (match) {
                                    host = `https://${match[1]}`;
                                }
                            }
                        }
                    }

                    // Append -review if on googlesource
                    if (host.includes('googlesource.com') && !host.includes('-review')) {
                        host = host.replace('.googlesource.com', '-review.googlesource.com');
                    }

                    // Verify if it is a Gerrit host
                    if (await this.probeGerritHost(host)) {
                        this._gerritHost = host;
                        this.outputChannel?.appendLine(`[GerritService] Detected host: ${this._gerritHost}`);
                        this._onDidUpdate.fire(); // Notify listeners that we are now enabled
                        return;
                    } else {
                        this.outputChannel?.appendLine(`[GerritService] Probe failed for host: ${host}`);
                    }
                }
            }
        } catch (e) {
            this.outputChannel?.appendLine(`[GerritService] Failed to detect git remotes: ${e}`);
        }

        this._gerritHost = undefined;
        this.outputChannel?.appendLine('[GerritService] No Gerrit host detected.');
    }

    private async probeGerritHost(host: string): Promise<boolean> {
        try {
            // Check server version, which is a lightweight standard endpoint
            const url = `${host}/config/server/version`;

            // Fast timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.ok) {
                return true;
            }
            // Some Gerrits might not expose version, check /changes/ (might be empty but returns 200)
            // Or check if it returns the magic prefix
            return false;
        } catch (e) {
            this.outputChannel?.appendLine(`[GerritService] Probe error: ${e}`);
            return false;
        }
    }

    public async isGerrit(): Promise<boolean> {
        return !!this._gerritHost;
    }

    /**
     * Fetch CL status using Change-Id from description (highest priority),
     * or computed Gerrit Change-Id from JJ Change-Id.
     */
    public getCachedClStatus(changeId?: string, description?: string): GerritClInfo | undefined {
        if (!this._gerritHost) {
            return undefined;
        }

        const cacheKey = this.resolveCacheKey(changeId, description);
        if (cacheKey && this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }
        return undefined;
    }

    private resolveCacheKey(changeId?: string, description?: string): string | undefined {
        // If we already have a Gerrit Change-Id, it's the strongest identifier.
        if (changeId?.startsWith('I')) {
            return changeId;
        }

        // 1. Check description for trailers (Change-Id footer or Link trailer)
        if (description) {
            for (const regex of GerritService.TRAILER_REGEXES) {
                const match = description.match(regex);
                if (match) {
                    return match[1];
                }
            }
        }

        // 2. Use computed JJ Change-Id if no description trailer found
        if (changeId) {
            try {
                const hexId = convertJjChangeIdToHex(changeId);
                return `I${hexId}`;
            } catch (e) {
                this.outputChannel?.appendLine(`[GerritService] Failed to convert JJ Change-Id: ${e}`);
            }
        }
        return undefined;
    }

    /**
     * Batch ensures fresh statuses for a list of items.
     * Returns true if any status changed from what was in the cache.
     */
    public async ensureFreshStatuses(
        changes: {
            commitId: string;
            parents: CommitParent[];
            changeId?: string;
            description?: string;
        }[],
    ): Promise<boolean> {
        if (!this._gerritHost || changes.length === 0) {
            return false;
        }

        const cacheKeysToFetch = new Set<string>();
        const changesByCacheKey = new Map<string, (typeof changes)[0][]>();

        for (const change of changes) {
            const cacheKey = this.resolveCacheKey(change.changeId, change.description);
            if (cacheKey) {
                cacheKeysToFetch.add(cacheKey);
                const list = changesByCacheKey.get(cacheKey) || [];
                list.push(change);
                changesByCacheKey.set(cacheKey, list);
            }
        }

        if (cacheKeysToFetch.size === 0) {
            return false;
        }

        const cacheKeysArray = Array.from(cacheKeysToFetch);
        const BATCH_SIZE = 10;
        const cacheKeyBatches = chunkArray(cacheKeysArray, BATCH_SIZE);

        // We process batches in parallel to minimize the total time spent waiting for network responses.
        // Each batch corresponds to a single Gerrit API request. Since these are network-bound operations
        // and not CPU-bound, parallelizing them significantly improves the responsiveness of the SCM view
        // during refresh, especially for large repositories with many changes.
        const batchPromises = cacheKeyBatches.map((batchCacheKeys, batchIndex) =>
            this._processBatch(batchCacheKeys, batchIndex, changesByCacheKey),
        );

        const results = await Promise.all(batchPromises);
        return results.some((changed) => changed);
    }

    private async _processBatch(
        batchCacheKeys: string[],
        batchIndex: number,
        changesByCacheKey: Map<string, { commitId: string; description?: string }[]>,
    ): Promise<boolean> {
        let batchChanged = false;
        this.outputChannel?.appendLine(
            `[GerritService] Fetching fresh status for batch ${batchIndex + 1} (${batchCacheKeys.length} changes)...`,
        );

        const fetchedInfoMap = await this._fetchBatchFromNetwork(batchCacheKeys);

        for (const cacheKey of batchCacheKeys) {
            const info = fetchedInfoMap.get(cacheKey);
            const oldInfo = this.cache.get(cacheKey);

            if (info) {
                const changesForCacheKey = changesByCacheKey.get(cacheKey) || [];
                // Run verifications for this cacheKey in parallel
                await Promise.all(
                    changesForCacheKey.map((change) =>
                        this._verifyContentSync(change.commitId, change.description, info),
                    ),
                );
                this.cache.set(cacheKey, info);
            } else {
                // This is expected for commits not yet on Gerrit
                this.cache.delete(cacheKey);
            }

            if (JSON.stringify(oldInfo) !== JSON.stringify(info)) {
                batchChanged = true;
            }
        }
        return batchChanged;
    }

    private async _fetchBatchFromNetwork(cacheKeys: string[]): Promise<Map<string, GerritClInfo>> {
        const results = new Map<string, GerritClInfo>();
        if (!this._gerritHost || cacheKeys.length === 0) {
            return results;
        }

        try {
            const baseUrl = `${this._gerritHost}/changes/`;
            const params = new URLSearchParams();
            // Use multiple 'q' parameters for batching.
            // Gerrit returns an array of arrays when multiple 'q' are provided.
            for (const key of cacheKeys) {
                params.append('q', `change:${key}`);
            }
            params.append('o', 'LABELS');
            params.append('o', 'SUBMITTABLE');
            params.append('o', 'CURRENT_REVISION');
            params.append('o', 'CURRENT_FILES');
            params.append('o', 'CURRENT_COMMIT');

            const urlStr = `${baseUrl}?${params.toString()}`;
            this.outputChannel?.appendLine(`[GerritService] GET ${urlStr}`);
            const response = await fetch(urlStr);
            if (!response.ok) {
                this.outputChannel?.appendLine(`[GerritService] Batch request failed: ${response.status}`);
                return results;
            }

            const text = await response.text();
            const queryResults = this._parseBatchResponse(text);

            for (let i = 0; i < queryResults.length; i++) {
                const matches = queryResults[i];
                if (Array.isArray(matches) && matches.length > 0) {
                    // Use the first match for this key
                    const info = this._parseGerritChange(matches[0]);
                    if (info) {
                        results.set(cacheKeys[i], info);
                    }
                }
            }
        } catch (error) {
            this.outputChannel?.appendLine(`[GerritService] Failed to fetch batch Gerrit status: ${error}`);
        }
        return results;
    }

    private _parseBatchResponse(text: string): GerritChange[][] {
        // Gerrit prefixes its JSON responses with a magic string to prevent JSON hijacking.
        // We must strip this prefix before parsing.
        const jsonStr = text.replace(/^\)]}'\n/, '');
        const data: GerritChange[] | GerritChange[][] = JSON.parse(jsonStr);

        return this._isBatchResponse(data) ? data : [data];
    }

    private _isBatchResponse(data: GerritChange[] | GerritChange[][]): data is GerritChange[][] {
        return data.length > 0 && Array.isArray(data[0]);
    }

    private _parseGerritChange(change: GerritChange): GerritClInfo | undefined {
        const currentRev = change.current_revision;
        let files: Record<string, { newSha?: string; status?: string }> | undefined;
        let remoteDescription: string | undefined;

        const rev = currentRev && change.revisions ? change.revisions[currentRev] : undefined;
        if (rev) {
            remoteDescription = rev.commit?.message;

            if (rev.files) {
                files = Object.entries(rev.files).reduce(
                    (acc, [path, fileInfo]) => {
                        if (!path.startsWith('/')) {
                            acc[path] = { newSha: fileInfo.new_sha, status: fileInfo.status };
                        }
                        return acc;
                    },
                    {} as Record<string, { newSha?: string; status?: string }>,
                );
            }
        }

        return {
            changeId: change.change_id,
            changeNumber: change._number,
            status: change.status,
            submittable: change.submittable,
            url: `${this._gerritHost}/c/${change._number}`,
            unresolvedComments: change.unresolved_comment_count || 0,
            currentRevision: change.current_revision,
            files,
            remoteDescription,
            gerritParents: rev?.commit?.parents?.map((p) => p.commit),
        };
    }

    /**
     * Verify whether a local commit's content matches its Gerrit revision
     * by comparing per-file blob SHA-1 hashes. Sets `contentSynced = true` if matching.
     */
    private async _verifyContentSync(
        commitId: string,
        description: string | undefined,
        info: GerritClInfo,
    ): Promise<void> {
        if (info.status !== 'NEW' || !info.files) {
            return;
        }

        if (info.currentRevision === commitId) {
            info.contentSynced = true;
            return;
        }

        // Verify description matches
        if (info.remoteDescription && description) {
            const normalize = (desc: string) => {
                // Gerrit appends trailers (Change-Id or Link) to the description.
                // Since our local description might not have these, we strip them out before comparing
                // to avoid false positive sync failures.
                let normalized = desc;
                for (const regex of GerritService.TRAILER_REGEXES) {
                    normalized = normalized.replace(new RegExp(regex.source, 'gm'), '');
                }
                return normalized.trim();
            };
            if (normalize(description) !== normalize(info.remoteDescription)) {
                return;
            }
        }

        const gerritFiles = info.files;
        try {
            // 1. Get filtered sets of "active" files (non-deleted)
            const localChanges = await this.jjService.getChanges(commitId);
            const localPaths = new Set(localChanges.filter((c) => c.status !== 'deleted').map((c) => c.path));

            const gerritPaths = Object.keys(gerritFiles).filter((p) => gerritFiles[p].status !== 'D');
            const gerritPathSet = new Set(gerritPaths);

            // 2. Compare sets
            if (localPaths.difference(gerritPathSet).size > 0 || gerritPathSet.difference(localPaths).size > 0) {
                return;
            }

            // 3. Sets match 1:1, so we only need to verify content hashes
            if (gerritPaths.length > 0) {
                const localHashes = await this.jjService.getGitBlobHashes(commitId, gerritPaths);

                for (const file of gerritPaths) {
                    const gerritFile = gerritFiles[file];
                    const localSha = localHashes.get(file);

                    if (!localSha || localSha !== gerritFile.newSha) {
                        return;
                    }
                }
            }

            info.contentSynced = true;
        } catch (e) {
            this.outputChannel?.appendLine(`[GerritService] Content sync verification failed for ${commitId}: ${e}`);
        }
    }

    /**
     * Verify whether a commit's Gerrit parent pointers match the latest patchsets
     * of its parents on the server.
     *
     * This ensures that if a parent has been rebased or had its content updated
     * on the server (creating a new patchset), the child correctly detects it
     * as "Needs Upload" even if the child's own content matches Gerrit.
     *
     * @param parents The local parents of the commit from `jj`.
     * @param info The Gerrit metadata for the commit to be verified.
     */
    private _verifyStructureSync(parents: CommitParent[], info: GerritClInfo): void {
        if (info.status !== 'NEW') {
            return;
        }

        // If there are no parents, it's structurally synced by definition.
        if (!info.gerritParents || info.gerritParents.length === 0) {
            info.parentSynced = true;
            return;
        }

        if (info.gerritParents.length !== parents.length) {
            info.parentSynced = false;
            return;
        }

        const matches = info.gerritParents.every((gerritParentSha, i) => {
            const localParent = parents[i];
            const parentCacheKey = this.resolveCacheKey(localParent.change_id);
            if (!parentCacheKey) {
                return false;
            }

            const parentInfo = this.cache.get(parentCacheKey);
            if (!parentInfo) {
                // If the parent is immutable and not in our Gerrit cache (e.g. root or external),
                // we verify it matches the Gerrit-recorded parent SHA directly.
                return localParent.is_immutable && localParent.commit_id === gerritParentSha;
            }

            // Does Gerrit's parent SHA for THIS commit match the currentRevision of the parent's Change in Gerrit?
            return parentInfo.currentRevision === gerritParentSha;
        });

        info.parentSynced = matches;
    }

    /**
     * Hydrates a list of commits with Gerrit information, including inherited
     * 'needsUpload' statuses based on the commit graph.
     */
    public populateGerritInfo(commits: import('./jj-types').JjLogEntry[]): void {
        if (!this.isEnabled) {
            return;
        }

        const commitMap = new Map<string, import('./jj-types').JjLogEntry>();
        for (const commit of commits) {
            if (commit.commit_id) {
                commitMap.set(commit.commit_id, commit);
                commit.gerritCl = this.getCachedClStatus(commit.change_id, commit.description);
            }
        }

        // Structural Pass: Verify parent pointers against Gerrit's current revisions.
        // We do this in a separate pass after the cache is fully populated for the current view.
        for (const commit of commits) {
            if (commit.gerritCl && commit.parents) {
                this._verifyStructureSync(commit.parents, commit.gerritCl);
                // Final sync status is an aggregate of content and structure.
                commit.gerritCl.synced = commit.gerritCl.contentSynced && commit.gerritCl.parentSynced;
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
            const gerritCl = commit.gerritCl;
            if (gerritCl && gerritCl.status === 'NEW') {
                const idMatches = gerritCl.currentRevision === commit.commit_id;
                const contentSynced = gerritCl.contentSynced === true;
                const parentSynced = gerritCl.parentSynced !== false;

                if (!(idMatches || (contentSynced && parentSynced))) {
                    needsUpload = true;
                    this.outputChannel?.appendLine(
                        `[GerritService] Commit ${commit.change_id.substring(0, 8)} needs upload: ` +
                            `idMatches=${idMatches}, contentSynced=${contentSynced}, parentSynced=${parentSynced} ` +
                            `(currentRevision=${gerritCl.currentRevision?.substring(0, 8)}, commitId=${commit.commit_id?.substring(0, 8)})`,
                    );
                }
            }

            if (!needsUpload && commit.parents) {
                for (const parent of commit.parents) {
                    if (computeNeedsUpload(parent.commit_id)) {
                        needsUpload = true;
                        this.outputChannel?.appendLine(
                            `[GerritService] Commit ${commit.change_id.substring(0, 8)} needs upload: inherited from parent ${parent.commit_id.substring(0, 8)}`,
                        );
                        break;
                    }
                }
            }

            needsUploadCache.set(commitId, needsUpload);
            return needsUpload;
        };

        for (const commit of commits) {
            if (commit.commit_id && commit.gerritCl && commit.gerritCl.status === 'NEW') {
                commit.gerritNeedsUpload = computeNeedsUpload(commit.commit_id);
            }
        }
    }
}
