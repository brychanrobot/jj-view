/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { FuzzyFileMatch } from '../../../src/core/host/host-system';
import type { ScmSnapshot } from '../../../src/core/scm-model';
import { Uri } from '../../../src/core/uri-utils';
import {
    collectPrioritizedQuickOpenFiles,
    makeQuickOpenItem,
    mergeQuickOpenItems,
    openQuickOpen,
} from '../../src/app/quick-open';
import type { QuickInputService } from '../../src/quick-input/quick-input-service';
import type { TabEntry } from '../../src/tabs/tab-types';
import { createMock } from '../test-mock';

describe('quick-open', () => {
    it('constructs a quick open item with correct label, description, and boost', () => {
        const item = makeQuickOpenItem('/repo/src/core/utils.ts', 'src/core/utils.ts', 'Open', 6000);
        expect(item.id).toBe('src/core/utils.ts');
        expect(item.label).toBe('utils.ts');
        expect(item.description).toBe('src/core');
        expect(item.detail).toBe('Open');
        expect(item.priorityBoost).toBe(6000);
        expect(item.filterText).toBe('src/core/utils.ts');
        expect(item.fullPath).toBe('/repo/src/core/utils.ts');
    });

    it('collects prioritized items ordered by open tabs then working copy changes without duplicates', () => {
        const searchRoot = '/repo';
        const repoRoot = '/repo';

        const openTab1: TabEntry = {
            id: 'file:/repo/src/active.ts',
            title: 'active.ts',
            preview: false,
            isDirty: false,
            view: {
                type: 'file',
                uri: Uri.file('/repo/src/active.ts'),
                title: 'active.ts',
            },
        };

        const openTab2: TabEntry = {
            id: 'file:/repo/src/other.ts',
            title: 'other.ts',
            preview: false,
            isDirty: false,
            view: {
                type: 'file',
                uri: Uri.file('/repo/src/other.ts'),
                title: 'other.ts',
            },
        };

        const snapshot: ScmSnapshot = createMock<ScmSnapshot>({
            conflictedPaths: ['src/conflicted.ts'],
            workingCopyChanges: [
                { path: 'src/active.ts', status: 'modified' },
                { path: 'src/new-file.ts', status: 'added' },
                { path: 'src/deleted.ts', status: 'deleted' },
            ],
        });

        const items = collectPrioritizedQuickOpenFiles(searchRoot, repoRoot, snapshot, [openTab1, openTab2], openTab1);

        // Open tabs come first, active tab prioritized
        expect(items.length).toBe(4);
        expect(items[0].fullPath).toBe('/repo/src/active.ts');
        expect(items[0].priorityBoost).toBe(6000);
        expect(items[0].detail).toBe('Open • Modified');

        expect(items[1].fullPath).toBe('/repo/src/other.ts');
        expect(items[1].priorityBoost).toBe(6000);
        expect(items[1].detail).toBe('Open');

        // Conflicted and added wc changes follow
        expect(items[2].fullPath).toBe('/repo/src/conflicted.ts');
        expect(items[2].priorityBoost).toBe(4000);
        expect(items[2].detail).toBe('Conflicted');

        expect(items[3].fullPath).toBe('/repo/src/new-file.ts');
        expect(items[3].priorityBoost).toBe(4000);
        expect(items[3].detail).toBe('Added');
    });

    it('merges prioritized items with workspace matches', () => {
        const item = makeQuickOpenItem('/repo/file.ts', 'file.ts', 'Open', 6000);
        const mergedEmpty = mergeQuickOpenItems('', [item], []);
        expect(mergedEmpty.length).toBe(1);
        expect(mergedEmpty[0].id).toBe('file.ts');

        const workspaceMatch: FuzzyFileMatch = {
            path: '/repo/other.ts',
            relPath: 'other.ts',
            score: 100,
        };
        const mergedWithMatch = mergeQuickOpenItems('', [item], [workspaceMatch]);
        expect(mergedWithMatch.length).toBe(2);
        expect(mergedWithMatch[0].id).toBe('file.ts');
        expect(mergedWithMatch[1].id).toBe('other.ts');

        // Query matching with score and priority boost
        const scoredMatches = mergeQuickOpenItems('file', [item], [workspaceMatch]);
        expect(scoredMatches.length).toBeGreaterThanOrEqual(1);
        expect(scoredMatches[0].id).toBe('file.ts');
    });

    it('deduplicates Windows backslash and mixed-case drive paths across tabs, snapshot, and fuzzy matches', () => {
        const winTab: TabEntry = {
            id: 'file:c:/Users/Dev/repo/src/active.ts',
            title: 'active.ts',
            preview: false,
            isDirty: false,
            view: {
                type: 'file',
                uri: createMock<Uri>({ scheme: 'file', fsPath: 'c:\\Users\\Dev\\repo\\src\\active.ts' }),
                title: 'active.ts',
            },
        };
        const snapshot: ScmSnapshot = createMock<ScmSnapshot>({
            conflictedPaths: [],
            workingCopyChanges: [{ path: 'src/active.ts', status: 'modified' }],
        });

        const prioritized = collectPrioritizedQuickOpenFiles(
            'C:\\Users\\Dev\\repo',
            'C:\\Users\\Dev\\repo',
            snapshot,
            [winTab],
            winTab,
        );
        expect(prioritized.length).toBe(1);
        expect(prioritized[0].detail).toBe('Open • Modified');

        const winBackendMatch: FuzzyFileMatch = {
            path: 'C:\\Users\\Dev\\repo\\src\\active.ts',
            relPath: 'src\\active.ts',
            score: 120,
        };
        expect(mergeQuickOpenItems('', prioritized, [winBackendMatch]).length).toBe(1);
        expect(mergeQuickOpenItems('active', prioritized, [winBackendMatch]).length).toBe(1);
    });

    it('handles selection and cancellation in openQuickOpen', async () => {
        let loadedUri: Uri | undefined;
        let pickResolver: ((val: { fullPath: string } | undefined) => void) | undefined;

        const mockQuickInput = createMock<QuickInputService>({
            showQuickPick: (async () => {
                return new Promise<{ fullPath: string } | undefined>((resolve) => {
                    pickResolver = resolve;
                });
            }) as QuickInputService['showQuickPick'],
            updateQuickPickItems: () => {},
        });

        const openPromise = openQuickOpen({
            activeQuickInput: mockQuickInput,
            workspaceRoot: '/repo',
            currentSnapshot: undefined,
            tabs: [],
            activeTab: undefined,
            loadFileFromUri: async (uri) => {
                loadedUri = uri;
            },
        });

        expect(pickResolver).toBeDefined();
        if (pickResolver) {
            pickResolver({ fullPath: '/repo/selected.ts' });
        }
        await openPromise;

        expect(loadedUri?.fsPath).toBeSameFsPath('/repo/selected.ts');

        // Cancellation case: resolver returns undefined
        loadedUri = undefined;
        const cancelPromise = openQuickOpen({
            activeQuickInput: mockQuickInput,
            workspaceRoot: '/repo',
            currentSnapshot: undefined,
            tabs: [],
            activeTab: undefined,
            loadFileFromUri: async (uri) => {
                loadedUri = uri;
            },
        });

        if (pickResolver) {
            pickResolver(undefined);
        }
        await cancelPromise;
        expect(loadedUri).toBeUndefined();
    });
});
