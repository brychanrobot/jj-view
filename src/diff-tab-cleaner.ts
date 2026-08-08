/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from './jj-service';
import { getRevisionFromUri, isJjScheme, type Uri } from './uri-utils';
import type { JjLoggerChannel } from './utils/output-channel';

interface CollectedTabs {
    uniqueRevisions: Set<string>;
    tabToRevisions: Map<vscode.Tab, string[]>;
}

export class DiffTabCleaner {
    private readonly revisionsCache = new Map<string, boolean>();
    private lastOpHeadsSignature = '';

    constructor(
        private readonly jj: JjService,
        private readonly belongsToRepo: (uri: Uri) => boolean,
        private readonly outputChannel?: JjLoggerChannel,
    ) {}

    /**
     * Coordinates collecting, checking, and closing invalid diff editor tabs.
     * A diff editor tab is considered invalid if it is displaying a revision or
     * change ID that is no longer valid (e.g., because the revision has been
     * squashed, abandoned, or no longer exists in the Jujutsu repository history).
     */
    public async closeInvalidDiffEditors(): Promise<void> {
        try {
            const tabGroups = vscode.window.tabGroups.all;
            const { uniqueRevisions, tabToRevisions } = this.collectDiffTabs(tabGroups);
            if (uniqueRevisions.size === 0) {
                return;
            }

            const invalidRevisions = await this.checkRevisionsValidity(uniqueRevisions);
            const tabsToClose = this.filterTabsToClose(tabToRevisions, invalidRevisions);

            await this.closeTabs(tabsToClose);
        } catch (err) {
            this.outputChannel?.error(`[DiffTabCleaner] Failed to check/close invalid diff editors: ${err}`);
        }
    }

    /**
     * Clears the validation cache and signature.
     */
    public clearCache(): void {
        this.revisionsCache.clear();
        this.lastOpHeadsSignature = '';
    }

    /**
     * Helper to read the current op heads and generate a hash of their filenames.
     */
    private async getOpHeadsSignature(): Promise<string> {
        try {
            const storePath = await this.jj.getRepoStorePath();
            const opHeadsDir = path.join(storePath, 'op_heads', 'heads');
            const files = await fs.readdir(opHeadsDir);
            files.sort();
            return crypto.createHash('sha256').update(files.join(',')).digest('hex');
        } catch {
            return '';
        }
    }

    /**
     * Scans all open tabs and collects those displaying diffs for this repository,
     * returning their associated revisions.
     */
    private collectDiffTabs(tabGroups: readonly vscode.TabGroup[]): CollectedTabs {
        const uniqueRevisions = new Set<string>();
        const tabToRevisions = new Map<vscode.Tab, string[]>();

        for (const group of tabGroups) {
            if (!group.tabs) {
                continue;
            }
            for (const tab of group.tabs) {
                if (!(tab.input instanceof vscode.TabInputTextDiff)) {
                    continue;
                }

                const revs = this.getRevisionsForTab(tab.input);
                if (revs.length > 0) {
                    tabToRevisions.set(tab, revs);
                    for (const rev of revs) {
                        uniqueRevisions.add(rev);
                    }
                }
            }
        }

        return { uniqueRevisions, tabToRevisions };
    }

    /**
     * Extracts a revision from a URI if it belongs to this repository and is not a working copy revision.
     */
    private getRevisionIfRelevant(uri: Uri): string | undefined {
        if (isJjScheme(uri) && this.belongsToRepo(uri)) {
            const rev = getRevisionFromUri(uri);
            if (rev && rev !== '@' && rev !== '@-') {
                return rev;
            }
        }
        return undefined;
    }

    /**
     * Extracts revision IDs from the original/modified URIs of a diff tab if they belong to this repo.
     */
    private getRevisionsForTab(input: vscode.TabInputTextDiff): string[] {
        const revs: string[] = [];
        const originalRev = this.getRevisionIfRelevant(input.original);
        if (originalRev) {
            revs.push(originalRev);
        }
        const modifiedRev = this.getRevisionIfRelevant(input.modified);
        if (modifiedRev) {
            revs.push(modifiedRev);
        }
        return revs;
    }

    /**
     * Evaluates revision validity against JjService, utilizing and maintaining the local cache.
     */
    private async checkRevisionsValidity(revisions: Set<string>): Promise<Set<string>> {
        const invalidRevisions = new Set<string>();
        if (revisions.size === 0) {
            return invalidRevisions;
        }

        const currentSignature = await this.getOpHeadsSignature();
        if (currentSignature !== this.lastOpHeadsSignature) {
            this.revisionsCache.clear();
            this.lastOpHeadsSignature = currentSignature;
        }

        const promises: Promise<void>[] = [];
        for (const rev of revisions) {
            const cached = this.revisionsCache.get(rev);
            if (cached !== undefined) {
                if (!cached) {
                    invalidRevisions.add(rev);
                }
                continue;
            }

            promises.push(
                (async () => {
                    try {
                        const logs = await this.jj.getLogIds({ revision: rev, limit: 1 });
                        const isValid = logs.length > 0;
                        this.revisionsCache.set(rev, isValid);
                        if (!isValid) {
                            invalidRevisions.add(rev);
                        }
                    } catch {
                        this.revisionsCache.set(rev, false);
                        invalidRevisions.add(rev);
                    }
                })(),
            );
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }

        return invalidRevisions;
    }

    /**
     * Identifies which tabs need to be closed based on invalid revisions.
     */
    private filterTabsToClose(tabToRevisions: Map<vscode.Tab, string[]>, invalidRevisions: Set<string>): vscode.Tab[] {
        const tabsToClose: vscode.Tab[] = [];
        for (const [tab, revs] of tabToRevisions.entries()) {
            if (revs.some((r) => invalidRevisions.has(r))) {
                tabsToClose.push(tab);
            }
        }
        return tabsToClose;
    }

    /**
     * Closes the specified tabs.
     */
    private async closeTabs(tabs: vscode.Tab[]): Promise<void> {
        await Promise.all(
            tabs.map(async (tab) => {
                try {
                    await vscode.window.tabGroups.close(tab);
                } catch (err) {
                    this.outputChannel?.error(`[DiffTabCleaner] Failed to close tab: ${err}`);
                }
            }),
        );
    }
}
