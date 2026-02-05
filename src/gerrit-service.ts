/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { GerritClInfo } from './jj-types';
import { JjService } from './jj-service';
import { convertJjChangeIdToHex } from './utils/jj-utils';

export class GerritService implements vscode.Disposable {
    private poller: NodeJS.Timeout | undefined;
    private cache: Map<string, GerritClInfo> = new Map();
    private _gerritHost: string | undefined;
    private _onDidUpdate = new vscode.EventEmitter<void>();
    public readonly onDidUpdate = this._onDidUpdate.event;

    constructor(
        private workspaceRoot: string,
        private jjService: JjService,
        private outputChannel?: vscode.OutputChannel // Optional for easier testing
    ) {
        this.detectGerritHost();
        
        // Listen for config changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('jj-view.gerrit')) {
                this.detectGerritHost();
            }
        });
    }

    dispose() {
        this.stopPolling();
        this._onDidUpdate.dispose();
    }

    public get isEnabled(): boolean {
        return !!this._gerritHost;
    }

    public startPolling() {
        if (this.poller) return;
        
        // Poll every 60 seconds
        this.poller = setInterval(() => {
            if (this.isEnabled && vscode.window.state.focused) {
                this.cache.clear();
                this._onDidUpdate.fire();
            }
        }, 60000);
    }

    public stopPolling() {
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = undefined;
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
                if (match && match[1]) {
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
            const origin = remotes.find(r => r.name === 'origin');
            const gerrit = remotes.find(r => r.name === 'gerrit');
            
            // Create a sorted list based on priority
            const sortedRemotes = [];
            if (origin) sortedRemotes.push(origin);
            if (gerrit) sortedRemotes.push(gerrit);
            // Add remaining
            remotes.forEach(r => {
                if (r.name !== 'origin' && r.name !== 'gerrit') sortedRemotes.push(r);
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
                    const match = url.match(/sso:\/\/([^\/]+)\/(.+)/);
                    if (match) {
                        host = `https://${match[1]}.googlesource.com/${match[2]}`;
                    }
                }

                if (host) {
                    // Handle SSH: ssh://user@host:port/path -> https://host
                    if (host.startsWith('ssh://')) {
                         const match = host.match(/ssh:\/\/([^@]+@)?([^:\/]+)(:\d+)?\/(.+)/);
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
        // 1. Check description for Change-Id
        if (description) {
            const match = description.match(/^Change-Id: (I[0-9a-fA-F]{40})/m);
            if (match) {
                return match[1];
            }
        }

        // 2. Use computed JJ Change-Id if no description ID found
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
     * Fetches status from network (bypass cache read), updates cache, and returns new value.
     */
    public async forceFetchAndCacheStatus(_commitId: string, changeId?: string, description?: string): Promise<GerritClInfo | undefined> {
        if (!this._gerritHost) {
            return undefined;
        }

        const cacheKey = this.resolveCacheKey(changeId, description);
        if (!cacheKey) {
            return undefined;
        }

        const info = await this._fetchFromNetwork(cacheKey);
        if (info) {
             this.cache.set(cacheKey, info);
        }
        return info;
    }

    /**
     * Batch ensures fresh statuses for a list of items.
     * Returns true if any status changed from what was in the cache.
     */
    public async ensureFreshStatuses(items: { commitId: string, changeId?: string, description?: string }[]): Promise<boolean> {
        if (!this._gerritHost) return false;

        const results = await Promise.all(items.map(async (item) => {
             const key = this.resolveCacheKey(item.changeId, item.description);
             if (!key) return false;

             const oldStatus = this.cache.get(key);
             const newStatus = await this.forceFetchAndCacheStatus(item.commitId, item.changeId, item.description);
             
             // Check for change
             return JSON.stringify(oldStatus) !== JSON.stringify(newStatus);
        }));

        return results.some(changed => changed);
    }

    public async fetchAndCacheStatus(_commitId: string, changeId?: string, description?: string): Promise<GerritClInfo | undefined> {
        if (!this._gerritHost) {
            return undefined;
        }

        const cacheKey = this.resolveCacheKey(changeId, description);
        if (!cacheKey) {
            return undefined;
        }

        const existing = this.getCachedClStatus(changeId, description);
        if (existing) {
             return existing;
        }
        
        // If not pending, fetch
        const info = await this._fetchFromNetwork(cacheKey);
        if (info) {
             this.cache.set(cacheKey, info);
        }
        return info;
    }

    private async _fetchFromNetwork(cacheKey: string): Promise<GerritClInfo | undefined> {
        if (!this._gerritHost) return undefined;
        
        const searchQ = `change:${cacheKey}`;
        try {
            const url = `${this._gerritHost}/changes/?q=${searchQ}&o=LABELS&o=SUBMITTABLE&o=CURRENT_REVISION`;
            
            const response = await fetch(url);
            if (!response.ok) {
                this.outputChannel?.appendLine(`[GerritService] Request failed: ${response.status}`);
                return undefined;
            }

            const text = await response.text();
            // Gerrit API returns ")]}'" prefix
            const jsonStr = text.replace(/^\)]}'\n/, '');
            const data = JSON.parse(jsonStr);

            // Search returns an array of changes
            if (!Array.isArray(data) || data.length === 0) {
                return undefined;
            }

            // Use the first match (typically the most relevant or only one)
            const change = data[0];

            const info: GerritClInfo = {
                changeId: change.change_id,
                changeNumber: change._number,
                status: change.status,
                submittable: change.submittable,
                url: `${this._gerritHost}/c/${change._number}`,
                unresolvedComments: change.unresolved_comment_count || 0,
                currentRevision: change.current_revision
            };
            return info;
        } catch (error) {
            this.outputChannel?.appendLine(`[GerritService] Failed to fetch Gerrit status for ${cacheKey}: ${error}`);
            return undefined;
        }
    }
}
