/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { DiffTabCleaner } from '../diff-tab-cleaner';
import { JjService, NO_OP_LOGGER } from '../jj-service';
import { getFsPathFromUri, Uri } from '../uri-utils';
import { buildGraph, TestRepo } from './test-repo';
import { exposePrivate } from './test-utils';

// Mock vscode
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    const mock = await createVscodeMock();
    const windowMock = mock.window as { tabGroups: { close: unknown } };
    windowMock.tabGroups.close = vi.fn().mockResolvedValue(true);
    return mock;
});

interface PrivateDiffTabCleaner {
    getOpHeadsSignature(): Promise<string>;
    collectDiffTabs(tabGroups: readonly vscode.TabGroup[]): {
        uniqueRevisions: Set<string>;
        tabToRevisions: Map<vscode.Tab, string[]>;
    };
    checkRevisionsValidity(revisions: Set<string>): Promise<Set<string>>;
    filterTabsToClose(tabToRevisions: Map<vscode.Tab, string[]>, invalidRevisions: Set<string>): vscode.Tab[];
    closeTabs(tabs: vscode.Tab[]): Promise<void>;
}

describe('Diff Tab Cleaner', () => {
    let repo: TestRepo;
    let jj: JjService;
    let cleaner: DiffTabCleaner;
    let privateCleaner: PrivateDiffTabCleaner;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        const belongsToRepo = (uri: Uri) => {
            const fsPath = getFsPathFromUri(uri);
            const normalizedUri = fsPath.replace(/\\/g, '/').toLowerCase();
            const normalizedRepo = repo.path.replace(/\\/g, '/').toLowerCase();
            return normalizedUri.startsWith(normalizedRepo);
        };
        cleaner = new DiffTabCleaner(jj, belongsToRepo);
        privateCleaner = exposePrivate<PrivateDiffTabCleaner>(cleaner);
    });

    afterEach(async () => {
        if (repo) {
        }
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

            const tab1 = {
                input: new vscode.TabInputTextDiff(uri1, uri2),
            } as unknown as vscode.Tab;

            const tabOther = {
                input: new vscode.TabInputTextDiff(uriOther, uriOther),
            } as unknown as vscode.Tab;

            const tabGroups = [
                {
                    tabs: [tab1, tabOther],
                },
            ] as unknown as vscode.TabGroup[];

            const { uniqueRevisions, tabToRevisions } = privateCleaner.collectDiffTabs(tabGroups);

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

            const tab = {
                input: new vscode.TabInputTextDiff(uri1, uri2),
            } as unknown as vscode.Tab;

            const tabGroups = [
                {
                    tabs: [tab],
                },
            ] as unknown as vscode.TabGroup[];

            const { uniqueRevisions, tabToRevisions } = privateCleaner.collectDiffTabs(tabGroups);

            expect(uniqueRevisions.size).toBe(0);
            expect(tabToRevisions.size).toBe(0);
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

            const tab = {
                input: new vscode.TabInputTextDiff(uri1, uri2),
            } as unknown as vscode.Tab;

            const tabGroups = [
                {
                    tabs: [tab],
                },
            ] as unknown as vscode.TabGroup[];

            const { uniqueRevisions, tabToRevisions } = privateCleaner.collectDiffTabs(tabGroups);

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
            const tab1 = { label: 'tab1' } as unknown as vscode.Tab;
            const tab2 = { label: 'tab2' } as unknown as vscode.Tab;

            const tabToRevisions = new Map<vscode.Tab, string[]>();
            tabToRevisions.set(tab1, ['rev-a']);
            tabToRevisions.set(tab2, ['rev-b']);

            const invalidRevisions = new Set(['rev-b']);
            const result = privateCleaner.filterTabsToClose(tabToRevisions, invalidRevisions);

            expect(result).toEqual([tab2]);
        });

        it('closes tabs that have multiple revisions where only one is invalid', () => {
            const tab = { label: 'tab' } as unknown as vscode.Tab;
            const tabToRevisions = new Map<vscode.Tab, string[]>();
            tabToRevisions.set(tab, ['rev-a', 'rev-b']);

            const invalidRevisions = new Set(['rev-b']);
            const result = privateCleaner.filterTabsToClose(tabToRevisions, invalidRevisions);

            expect(result).toEqual([tab]);
        });
    });

    describe('closeTabs', () => {
        it('closes tabs using vscode API', async () => {
            const closeSpy = vscode.window.tabGroups.close as unknown as { mockClear: () => void };
            closeSpy.mockClear();

            const tab = { label: 'tab' } as unknown as vscode.Tab;
            await privateCleaner.closeTabs([tab]);

            expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(tab);
        });
    });

    describe('closeInvalidDiffEditors', () => {
        it('orchestrates collecting, checking, and closing invalid tabs using real repository state', async () => {
            const closeSpy = vscode.window.tabGroups.close as unknown as { mockClear: () => void };
            closeSpy.mockClear();

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

            const tab1 = {
                input: new vscode.TabInputTextDiff(uri1, uri1),
            } as unknown as vscode.Tab;

            const tab2 = {
                input: new vscode.TabInputTextDiff(uri2, uri2),
            } as unknown as vscode.Tab;

            (vscode.window.tabGroups as unknown as { all: unknown[] }).all = [{ tabs: [tab1, tab2] }];

            await cleaner.closeInvalidDiffEditors();

            expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(tab2);
            expect(vscode.window.tabGroups.close).not.toHaveBeenCalledWith(tab1);
        });
    });
});
