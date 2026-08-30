/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toError } from '../utils/error-utils';
import type { LoggerChannel } from '../utils/output-channel';
import type { HostDiffTab, HostEnvironment } from './host/host-environment';
import type { JjService } from './jj-service';
import { getRevisionFromUri, isJjScheme, type Uri } from './uri-utils';

interface CollectedTabs {
    uniqueRevisions: Set<string>;
    tabToRevisions: Map<HostDiffTab, string[]>;
}

export class DiffTabCleaner {
    private readonly revisionsCache = new Map<string, boolean>();
    private lastOpHeadsSignature = '';

    constructor(
        private readonly jj: JjService,
        private readonly belongsToRepo: (uri: Uri) => boolean,
        private readonly host: HostEnvironment,
        private readonly outputChannel?: LoggerChannel,
    ) {}

    /**
     * Coordinates collecting, checking, and closing invalid diff editor tabs.
     * A diff editor tab is considered invalid if it is displaying a revision or
     * change ID that is no longer valid (e.g., because the revision has been
     * squashed, abandoned, or no longer exists in the Jujutsu repository history).
     */
    public async closeInvalidDiffEditors(): Promise<void> {
        try {
            const diffTabs = this.host.documents.getOpenDiffTabs?.() ?? [];
            const { uniqueRevisions, tabToRevisions } = this.collectDiffTabs(diffTabs);
            if (uniqueRevisions.size === 0) {
                return;
            }

            const invalidRevisions = await this.checkRevisionsValidity(uniqueRevisions);
            const tabsToClose = this.filterTabsToClose(tabToRevisions, invalidRevisions);

            this.closeTabs(tabsToClose);
        } catch (err) {
            this.outputChannel?.error('[DiffTabCleaner] Failed to check/close invalid diff editors', toError(err));
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
    private collectDiffTabs(diffTabs: readonly HostDiffTab[]): CollectedTabs {
        const uniqueRevisions = new Set<string>();
        const tabToRevisions = new Map<HostDiffTab, string[]>();

        for (const tab of diffTabs) {
            const revs = this.getRevisionsForTab(tab);
            if (revs.length > 0) {
                tabToRevisions.set(tab, revs);
                for (const rev of revs) {
                    uniqueRevisions.add(rev);
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
    private getRevisionsForTab(tab: HostDiffTab): string[] {
        const revs: string[] = [];
        const originalRev = this.getRevisionIfRelevant(tab.originalUri);
        if (originalRev) {
            revs.push(originalRev);
        }
        const modifiedRev = this.getRevisionIfRelevant(tab.modifiedUri);
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
    private filterTabsToClose(
        tabToRevisions: Map<HostDiffTab, string[]>,
        invalidRevisions: Set<string>,
    ): HostDiffTab[] {
        const tabsToClose: HostDiffTab[] = [];
        for (const [tab, revs] of tabToRevisions.entries()) {
            if (revs.some((r) => invalidRevisions.has(r))) {
                tabsToClose.push(tab);
            }
        }
        return tabsToClose;
    }

    /**
     * Closes the specified tabs asynchronously.
     */
    private closeTabs(tabs: HostDiffTab[]): void {
        tabs.forEach((tab) => {
            tab.close().catch((err) => {
                this.outputChannel?.error('[DiffTabCleaner] Failed to close tab', toError(err));
            });
        });
    }
}
