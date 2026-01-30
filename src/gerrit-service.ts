/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GerritClInfo } from './jj-types';

import { JjService } from './jj-service';


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
        
        // Poll every 30 seconds
        this.poller = setInterval(() => {
            if (this.isEnabled && vscode.window.state.focused) {
                this.cache.clear();
                this._onDidUpdate.fire();
            }
        }, 30000);
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
            this.outputChannel?.appendLine(`[GerritService] Found remotes: ${JSON.stringify(remotes)}`);
            
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

                if (url.includes('googlesource.com') || url.includes('/gerrit/')) {
                    let host = url;
                    
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
                    
                    this._gerritHost = host;
                    this.outputChannel?.appendLine(`[GerritService] Detected host: ${this._gerritHost}`);
                    this._onDidUpdate.fire(); // Notify listeners that we are now enabled
                    return;
                }
            }
        } catch (e) {
            this.outputChannel?.appendLine(`[GerritService] Failed to detect git remotes: ${e}`);
        }

        this._gerritHost = undefined;
        this.outputChannel?.appendLine('[GerritService] No Gerrit host detected.');
    }

    public async isGerrit(): Promise<boolean> {
        return !!this._gerritHost;
    }

    /**
     * Fetch CL status using Commit SHA (most robust) or Change-Id (if available).
     * We receive the commit ID (SHA) or Change ID.
     * By design, we should use the commit SHA: `q=commit:<sha>`
     */
    public async fetchClStatus(commitId: string): Promise<GerritClInfo | undefined> {
        this.outputChannel?.appendLine(`[GerritService] fetchClStatus called for ${commitId}`);
        if (!this._gerritHost) {
            this.outputChannel?.appendLine('[GerritService] No host configured, skipping.');
            return undefined;
        }

        if (this.cache.has(commitId)) {
            this.outputChannel?.appendLine(`[GerritService] Returning cached status for ${commitId}`);
            return this.cache.get(commitId);
        }

        try {
            // Query by commit SHA
            // o=CURRENT_REVISION: to Get the standard SHA of the latest patchset
            const url = `${this._gerritHost}/changes/?q=commit:${commitId}&o=LABELS&o=SUBMITTABLE&o=CURRENT_REVISION`;
            this.outputChannel?.appendLine(`[GerritService] Querying URL: ${url}`);
            
            const response = await fetch(url);
            if (!response.ok) {
                this.outputChannel?.appendLine(`[GerritService] Request failed: ${response.status}`);
                return undefined;
            }

            const text = await response.text();
            // Gerrit API returns ")]}'" prefix
            const jsonStr = text.replace(/^\)]}'\n/, '');
            const data = JSON.parse(jsonStr);
            this.outputChannel?.appendLine(`[GerritService] Received data: ${JSON.stringify(data)}`);

            // Search returns an array of changes
            if (!Array.isArray(data) || data.length === 0) {
                this.outputChannel?.appendLine(`[GerritService] No changes found for commit ${commitId}`);
                return undefined;
            }

            // Use the first match (usually only one for a specific commit SHA)
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

            this.cache.set(commitId, info);
            return info;

        } catch (error) {
            this.outputChannel?.appendLine(`[GerritService] Failed to fetch Gerrit status for ${commitId}: ${error}`);
            return undefined;
        }
    }
}
