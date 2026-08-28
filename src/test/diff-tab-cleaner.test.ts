/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostDiffTab } from '../common/host-environment';
import { DiffTabCleaner } from '../diff-tab-cleaner';
import { JjService, NO_OP_LOGGER } from '../jj-service';
import { getFsPathFromUri, Uri } from '../uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { exposePrivate } from './test-utils';

interface PrivateDiffTabCleaner {
    getOpHeadsSignature(): Promise<string>;
    collectDiffTabs(diffTabs: readonly HostDiffTab[]): {
        uniqueRevisions: Set<string>;
        tabToRevisions: Map<HostDiffTab, string[]>;
    };
    checkRevisionsValidity(revisions: Set<string>): Promise<Set<string>>;
    filterTabsToClose(tabToRevisions: Map<HostDiffTab, string[]>, invalidRevisions: Set<string>): HostDiffTab[];
    closeTabs(tabs: HostDiffTab[]): void;
}

function createMockDiffTab(originalUri: Uri, modifiedUri: Uri): HostDiffTab & { close: ReturnType<typeof vi.fn> } {
    return {
        originalUri,
        modifiedUri,
        close: vi.fn().mockResolvedValue(undefined),
    };
}

describe('Diff Tab Cleaner', () => {
    let repo: TestRepo;
    let jj: JjService;
    let host: FakeHostEnvironment;
    let cleaner: DiffTabCleaner;
    let privateCleaner: PrivateDiffTabCleaner;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        host = new FakeHostEnvironment();

        const belongsToRepo = (uri: Uri) => {
            const fsPath = getFsPathFromUri(uri);
            const normalizedUri = fsPath.replace(/\\/g, '/').toLowerCase();
            const normalizedRepo = repo.path.replace(/\\/g, '/').toLowerCase();
            return normalizedUri.startsWith(normalizedRepo);
        };
        cleaner = new DiffTabCleaner(jj, belongsToRepo, host);
        privateCleaner = exposePrivate<PrivateDiffTabCleaner>(cleaner);
    });

    describe('collectDiffTabs', () => {
        it('collects diff tabs belonging to the repo and extracts their revisions', () => {
            const repoRoot = repo.path;
            const uri1 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repoRoot)}&base=rev123&side=left`,
            });
            const uri2 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repoRoot)}&base=rev123&side=right`,
            });

            // Tab belonging to another repo
            const uriOther = Uri.from({
                scheme: 'jj-view',
                path: '/src/file.ts',
                fragment: 'root=%2Fother%2Frepo&base=rev456&side=left',
            });

            const tab1 = createMockDiffTab(uri1, uri2);
            const tabOther = createMockDiffTab(uriOther, uriOther);

            const { uniqueRevisions, tabToRevisions } = privateCleaner.collectDiffTabs([tab1, tabOther]);

            expect(uniqueRevisions.has('rev123')).toBe(true);
            expect(uniqueRevisions.has('rev456')).toBe(false);
            expect(tabToRevisions.size).toBe(1);
            expect(tabToRevisions.get(tab1)).toEqual(['rev123', 'rev123']);
        });

        it('ignores working copy revisions (@ and @-)', () => {
            const repoRoot = repo.path;
            const uri1 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repoRoot)}&base=@&side=left`,
            });
            const uri2 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repoRoot)}&base=@-&side=right`,
            });

            const tab = createMockDiffTab(uri1, uri2);
            const { uniqueRevisions, tabToRevisions } = privateCleaner.collectDiffTabs([tab]);

            expect(uniqueRevisions.size).toBe(0);
            expect(tabToRevisions.size).toBe(0);
        });

        it('extracts only the historical revision when compared with a working copy revision', () => {
            const repoRoot = repo.path;
            const uri1 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repoRoot)}&base=@&side=left`,
            });
            const uri2 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repoRoot)}&base=rev123&side=right`,
            });

            const tab = createMockDiffTab(uri1, uri2);
            const { uniqueRevisions, tabToRevisions } = privateCleaner.collectDiffTabs([tab]);

            expect(uniqueRevisions.size).toBe(1);
            expect(uniqueRevisions.has('rev123')).toBe(true);
            expect(tabToRevisions.size).toBe(1);
            expect(tabToRevisions.get(tab)).toEqual(['rev123']);
        });

        it('ignores tabs with non jj view or jj edit schemas', () => {
            const repoRoot = repo.path;
            const uri1 = Uri.from({
                scheme: 'file',
                path: `${repoRoot}/src/file1.ts`,
                query: 'base=rev123&side=left',
            });
            const uri2 = Uri.from({
                scheme: 'git',
                path: `${repoRoot}/src/file1.ts`,
                query: 'base=rev123&side=right',
            });

            const tab = createMockDiffTab(uri1, uri2);
            const { uniqueRevisions, tabToRevisions } = privateCleaner.collectDiffTabs([tab]);

            expect(uniqueRevisions.size).toBe(0);
            expect(tabToRevisions.size).toBe(0);
        });
    });

    describe('checkRevisionsValidity', () => {
        it('identifies invalid revisions using a real JjService', async () => {
            const ids = await buildGraph(repo, [{ label: 'commitA', description: 'desc A' }]);
            const validRev = ids.commitA.changeId;
            const invalidRev = 'non-existent-rev';

            const revisions = new Set([validRev, invalidRev]);
            const invalid = await privateCleaner.checkRevisionsValidity(revisions);

            expect(invalid.has(validRev)).toBe(false);
            expect(invalid.has(invalidRev)).toBe(true);
        });

        it('caches validated (valid) revisions', async () => {
            const ids = await buildGraph(repo, [{ label: 'commitA', description: 'desc A' }]);
            const validRev = ids.commitA.changeId;

            // Pin the signature to prevent the abandon operation from invalidating the cache
            vi.spyOn(privateCleaner, 'getOpHeadsSignature').mockResolvedValue('constant-sig');

            // 1. Initial check - validRev is valid
            const invalid1 = await privateCleaner.checkRevisionsValidity(new Set([validRev]));
            expect(invalid1.has(validRev)).toBe(false);

            // 2. Abandon the commit to make it invalid
            await jj.abandon([validRev]);

            // 3. Check again - should still be considered valid due to caching
            const invalid2 = await privateCleaner.checkRevisionsValidity(new Set([validRev]));
            expect(invalid2.has(validRev)).toBe(false);

            // 4. Clear cache and check again - now it should be recognized as invalid
            cleaner.clearCache();
            const invalid3 = await privateCleaner.checkRevisionsValidity(new Set([validRev]));
            expect(invalid3.has(validRev)).toBe(true);
        });

        it('invalidates cache when op-heads signature changes', async () => {
            const ids = await buildGraph(repo, [{ label: 'commitA', description: 'desc A' }]);
            const validRev = ids.commitA.changeId;
            const revisions = new Set([validRev]);

            const getOpHeadsSignatureSpy = vi.spyOn(privateCleaner, 'getOpHeadsSignature');
            getOpHeadsSignatureSpy.mockResolvedValueOnce('signature-1');

            // 1. Initial check - validRev is valid
            let invalid = await privateCleaner.checkRevisionsValidity(revisions);
            expect(invalid.has(validRev)).toBe(false);

            // 2. Force a different signature on next check
            getOpHeadsSignatureSpy.mockResolvedValueOnce('signature-2');

            // 3. Make revision invalid by abandoning it
            await jj.abandon([validRev]);

            // 4. Check again - cache should be bypassed/cleared and revision is invalid
            invalid = await privateCleaner.checkRevisionsValidity(revisions);
            expect(invalid.has(validRev)).toBe(true);

            getOpHeadsSignatureSpy.mockRestore();
        });
    });

    describe('filterTabsToClose', () => {
        it('identifies which tabs to close based on invalid revisions', () => {
            const uriA = Uri.from({ scheme: 'jj-view', path: '/a', fragment: 'base=rev-a' });
            const uriB = Uri.from({ scheme: 'jj-view', path: '/b', fragment: 'base=rev-b' });
            const tab1 = createMockDiffTab(uriA, uriA);
            const tab2 = createMockDiffTab(uriB, uriB);

            const tabToRevisions = new Map<HostDiffTab, string[]>();
            tabToRevisions.set(tab1, ['rev-a']);
            tabToRevisions.set(tab2, ['rev-b']);

            const invalidRevisions = new Set(['rev-b']);
            const result = privateCleaner.filterTabsToClose(tabToRevisions, invalidRevisions);

            expect(result).toEqual([tab2]);
        });

        it('closes tabs that have multiple revisions where only one is invalid', () => {
            const uriA = Uri.from({ scheme: 'jj-view', path: '/a', fragment: 'base=rev-a' });
            const uriB = Uri.from({ scheme: 'jj-view', path: '/b', fragment: 'base=rev-b' });
            const tab = createMockDiffTab(uriA, uriB);
            const tabToRevisions = new Map<HostDiffTab, string[]>();
            tabToRevisions.set(tab, ['rev-a', 'rev-b']);

            const invalidRevisions = new Set(['rev-b']);
            const result = privateCleaner.filterTabsToClose(tabToRevisions, invalidRevisions);

            expect(result).toEqual([tab]);
        });
    });

    describe('closeTabs', () => {
        it('closes tabs using HostDiffTab.close()', async () => {
            const uri = Uri.from({ scheme: 'jj-view', path: '/a', fragment: 'base=rev-a' });
            const tab = createMockDiffTab(uri, uri);
            privateCleaner.closeTabs([tab]);

            expect(tab.close).toHaveBeenCalledTimes(1);
        });
    });

    describe('closeInvalidDiffEditors', () => {
        it('orchestrates collecting, checking, and closing invalid tabs using real repository state', async () => {
            const ids = await buildGraph(repo, [{ label: 'commitA', description: 'desc A' }]);
            const validRev = ids.commitA.changeId;
            const invalidRev = 'non-existent-rev-xyz';

            const uri1 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repo.path)}&base=${validRev}&side=left`,
            });
            const uri2 = Uri.from({
                scheme: 'jj-view',
                path: '/src/file1.ts',
                fragment: `root=${encodeURIComponent(repo.path)}&base=${invalidRev}&side=left`,
            });

            const tab1 = createMockDiffTab(uri1, uri1);
            const tab2 = createMockDiffTab(uri2, uri2);

            host.documents.openDiffTabs = [tab1, tab2];

            await cleaner.closeInvalidDiffEditors();

            expect(tab2.close).toHaveBeenCalledTimes(1);
            expect(tab1.close).not.toHaveBeenCalled();
        });
    });
});
