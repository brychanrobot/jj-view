/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangeStatusRequest, CodeForgeProvider, GitRemote } from './code-forge-provider';
import type { JjService } from './jj-service';
import type { CodeForgeChangeInfo } from './jj-types';
import { chunkArray } from './utils/array-utils';
import { fetchWithTimeout } from './utils/fetch-utils';
import { resolveGerritChangeKey, stripGerritTrailers } from './utils/gerrit-utils';
import { convertJjChangeIdToHex } from './utils/jj-utils';

export interface GerritFile {
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

export class GerritProvider implements CodeForgeProvider {
    public readonly id = 'gerrit';
    public readonly displayName = 'Gerrit';
    public readonly changeTerm = 'CL' as const;

    private cache = new Map<string, CodeForgeChangeInfo>();
    private gerritHost: string | undefined;

    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    constructor(
        private jjService: JjService,
        private outputChannel?: vscode.OutputChannel,
    ) {}

    public async detect(workspaceRoot: string, remotes: GitRemote[]): Promise<boolean> {
        const detectedHost = vscode.workspace.getConfiguration('jj-view').get<string>('gerrit.host')?.trim();
        if (detectedHost) {
            const host = detectedHost.replace(/\/$/, '');
            if (this.gerritHost !== host) {
                this.clearCache();
            }
            this.gerritHost = host;
            return true;
        }

        // Check .gitreview file
        try {
            const gitreviewPath = path.join(workspaceRoot, '.gitreview');
            if (fs.existsSync(gitreviewPath)) {
                const content = await fs.promises.readFile(gitreviewPath, 'utf8');
                const match = content.match(/host=(.+)/);
                if (match?.[1]) {
                    let host = match[1].trim();
                    if (!host.startsWith('http')) {
                        host = `https://${host}`;
                    }
                    const cleanHost = host.replace(/\/$/, '');
                    if (this.gerritHost !== cleanHost) {
                        this.clearCache();
                    }
                    this.gerritHost = cleanHost;
                    return true;
                }
            }
        } catch (e) {
            this.outputChannel?.appendLine(`[GerritProvider] Failed to parse .gitreview: ${e}`);
        }

        // Check git remotes via jj
        // Prioritize 'origin', then 'gerrit', then others
        const origin = remotes.find((r) => r.name === 'origin');
        const gerrit = remotes.find((r) => r.name === 'gerrit');

        const sortedRemotes = [];
        if (origin) {
            sortedRemotes.push(origin);
        }
        if (gerrit) {
            sortedRemotes.push(gerrit);
        }
        remotes.forEach((r) => {
            if (r.name !== 'origin' && r.name !== 'gerrit') {
                sortedRemotes.push(r);
            }
        });

        for (const { name, url } of sortedRemotes) {
            this.outputChannel?.appendLine(`[GerritProvider] Checking remote '${name}' URL: '${url}'`);

            let host: string | undefined;

            if (url.includes('googlesource.com') || url.includes('/gerrit/')) {
                host = url;
            } else if (url.startsWith('sso://')) {
                const match = url.match(/sso:\/\/([^/]+)\/(.+)/);
                if (match) {
                    host = `https://${match[1]}.googlesource.com/${match[2]}`;
                }
            }

            if (host) {
                if (host.startsWith('ssh://')) {
                    const match = host.match(/ssh:\/\/([^@]+@)?([^:/]+)(:\d+)?\/(.+)/);
                    if (match) {
                        host = `https://${match[2]}`;
                    }
                }

                if (host.endsWith('.git')) {
                    host = host.slice(0, -4);
                }

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

                if (host.includes('googlesource.com') && !host.includes('-review')) {
                    host = host.replace('.googlesource.com', '-review.googlesource.com');
                }

                if (await this.probeGerritHost(host)) {
                    if (this.gerritHost !== host) {
                        this.clearCache();
                    }
                    this.gerritHost = host;
                    return true;
                } else {
                    this.outputChannel?.appendLine(`[GerritProvider] Probe failed for host: ${host}`);
                }
            }
        }

        this.gerritHost = undefined;
        return false;
    }

    private async probeGerritHost(host: string): Promise<boolean> {
        try {
            const response = await fetchWithTimeout(`${host}/config/server/version`, 3000);
            return response.ok;
        } catch (e) {
            this.outputChannel?.appendLine(`[GerritProvider] Probe error for host ${host}: ${e}`);
            return false;
        }
    }

    public getCachedChangeInfo(
        changeId?: string,
        description?: string,
        _bookmarks?: string[],
    ): CodeForgeChangeInfo | undefined {
        if (!this.gerritHost) {
            return undefined;
        }

        const cacheKey = this.resolveCacheKey(changeId, description);
        if (cacheKey && this.cache.has(cacheKey)) {
            const info = this.cache.get(cacheKey);
            return info ? { ...info } : undefined;
        }

        return undefined;
    }

    private resolveCacheKey(changeId?: string, description?: string): string | undefined {
        if (changeId?.startsWith('I')) {
            return changeId;
        }

        if (description) {
            const parsed = resolveGerritChangeKey(description, this.gerritHost);
            if (parsed) {
                return parsed;
            }
        }

        if (changeId) {
            try {
                const hexId = convertJjChangeIdToHex(changeId);
                return `I${hexId}`;
            } catch (e) {
                this.outputChannel?.appendLine(`[GerritProvider] Failed to convert JJ Change-Id: ${e}`);
            }
        }
        return undefined;
    }

    public async fetchStatuses(changes: ChangeStatusRequest[]): Promise<boolean> {
        if (!this.gerritHost || changes.length === 0) {
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

        const batchPromises = cacheKeyBatches.map((batchCacheKeys, batchIndex) =>
            this.processBatch(batchCacheKeys, batchIndex, changesByCacheKey),
        );

        const results = await Promise.all(batchPromises);
        const changed = results.some((c) => c);
        if (changed) {
            this._onDidUpdate.fire();
        }
        return changed;
    }

    private async processBatch(
        batchCacheKeys: string[],
        batchIndex: number,
        changesByCacheKey: Map<string, { commitId: string; description?: string }[]>,
    ): Promise<boolean> {
        let batchChanged = false;
        this.outputChannel?.appendLine(
            `[GerritProvider] Fetching fresh status for batch ${batchIndex + 1} (${batchCacheKeys.length} changes)...`,
        );

        let fetchedInfoMap: Map<string, CodeForgeChangeInfo>;
        try {
            fetchedInfoMap = await this.fetchBatchFromNetwork(batchCacheKeys);
        } catch (error) {
            this.outputChannel?.appendLine(`[GerritProvider] Failed to fetch batch Gerrit status: ${error}`);
            return false;
        }

        for (const cacheKey of batchCacheKeys) {
            const info = fetchedInfoMap.get(cacheKey);
            const oldInfo = this.cache.get(cacheKey);

            if (info) {
                const changesForCacheKey = changesByCacheKey.get(cacheKey) || [];
                await Promise.all(
                    changesForCacheKey.map((change) =>
                        this.verifyContentSync(change.commitId, change.description, info),
                    ),
                );
                this.cache.set(cacheKey, info);
            } else {
                this.cache.delete(cacheKey);
            }

            if (JSON.stringify(oldInfo) !== JSON.stringify(info)) {
                batchChanged = true;
            }
        }
        return batchChanged;
    }

    private async fetchBatchFromNetwork(cacheKeys: string[]): Promise<Map<string, CodeForgeChangeInfo>> {
        const results = new Map<string, CodeForgeChangeInfo>();
        if (!this.gerritHost || cacheKeys.length === 0) {
            return results;
        }

        const baseUrl = `${this.gerritHost}/changes/`;
        const params = new URLSearchParams();
        for (const key of cacheKeys) {
            params.append('q', `change:${key}`);
        }
        params.append('o', 'LABELS');
        params.append('o', 'SUBMITTABLE');
        params.append('o', 'CURRENT_REVISION');
        params.append('o', 'CURRENT_FILES');
        params.append('o', 'CURRENT_COMMIT');

        const urlStr = `${baseUrl}?${params.toString()}`;
        this.outputChannel?.appendLine(`[GerritProvider] GET ${urlStr}`);
        const response = await fetchWithTimeout(urlStr, 15000);
        if (!response.ok) {
            throw new Error(`Batch request failed with status: ${response.status}`);
        }

        const text = await response.text();
        const queryResults = this.parseBatchResponse(text);

        for (let i = 0; i < queryResults.length; i++) {
            const matches = queryResults[i];
            if (Array.isArray(matches) && matches.length > 0) {
                const info = this.parseGerritChange(matches[0]);
                if (info) {
                    results.set(cacheKeys[i], info);
                }
            }
        }
        return results;
    }

    private parseBatchResponse(text: string): GerritChange[][] {
        const jsonStr = text.replace(/^\)]}'\n/, '');
        const data: GerritChange[] | GerritChange[][] = JSON.parse(jsonStr);
        return this.isBatchResponse(data) ? data : [data];
    }

    private isBatchResponse(data: GerritChange[] | GerritChange[][]): data is GerritChange[][] {
        return data.length > 0 && Array.isArray(data[0]);
    }

    private parseGerritChange(change: GerritChange): CodeForgeChangeInfo | undefined {
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
            id: change.change_id,
            number: change._number,
            displayLabel: `CL/${change._number}`,
            providerName: 'Gerrit',
            status: change.status,
            submittable: change.submittable,
            url: `${this.gerritHost}/c/${change._number}`,
            unresolvedComments: change.unresolved_comment_count || 0,
            currentRevision: change.current_revision,
            files,
            remoteDescription,
            remoteParents: rev?.commit?.parents?.map((p) => p.commit),
        };
    }

    private async verifyContentSync(
        commitId: string,
        description: string | undefined,
        info: CodeForgeChangeInfo,
    ): Promise<void> {
        if (info.status !== 'NEW' || !info.files) {
            return;
        }

        if (info.currentRevision === commitId) {
            info.contentSynced = true;
            return;
        }

        if (info.remoteDescription && description) {
            if (stripGerritTrailers(description) !== stripGerritTrailers(info.remoteDescription)) {
                return;
            }
        }

        const gerritFiles = info.files;
        try {
            const localChanges = await this.jjService.getChanges(commitId);
            const localPaths = new Set(localChanges.filter((c) => c.status !== 'deleted').map((c) => c.path));

            const gerritPaths = Object.keys(gerritFiles).filter((p) => gerritFiles[p].status !== 'D');
            const gerritPathSet = new Set(gerritPaths);

            if (localPaths.difference(gerritPathSet).size > 0 || gerritPathSet.difference(localPaths).size > 0) {
                return;
            }

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
            this.outputChannel?.appendLine(`[GerritProvider] Content sync verification failed for ${commitId}: ${e}`);
        }
    }

    public getUploadCommand(
        revision: string,
        _hasBookmark?: boolean,
    ): { subcommand: string; args: string[] } | undefined {
        return { subcommand: 'gerrit', args: ['upload', '-r', revision] };
    }

    public clearCache(): void {
        this.cache.clear();
        this._onDidUpdate.fire();
    }

    public activate(): void {
        this.outputChannel?.appendLine('[GerritProvider] Activated');
    }

    public deactivate(): void {
        this.outputChannel?.appendLine('[GerritProvider] Deactivated');
    }
}
