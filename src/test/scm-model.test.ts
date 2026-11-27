/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { ScmModel, type ScmSnapshot } from '../core/scm-model';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('ScmModel Domain Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let scmModel: ScmModel;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(testRepo.path));

        repositoryManager = new JjRepositoryManager(registry, outputChannel, host);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        scmModel = new ScmModel(repo, outputChannel);
    });

    afterEach(async () => {
        scmModel.dispose();
        await repositoryManager.dispose();
        await testRepo.dispose();
    });

    test('computes working copy changes and fires onDidChangeSnapshot', async () => {
        const snapshots: ScmSnapshot[] = [];
        scmModel.onDidChangeSnapshot((s) => {
            snapshots.push(s);
        });

        testRepo.writeFile('test.txt', 'hello world\n');
        await scmModel.updateSnapshot({ reason: 'test write' });

        expect(snapshots.length).toBeGreaterThan(0);
        const lastSnapshot = snapshots[snapshots.length - 1];
        expect(lastSnapshot.workingCopyChanges.length).toBeGreaterThanOrEqual(1);
        expect(lastSnapshot.workingCopyChanges.some((c) => c.path.includes('test.txt'))).toBe(true);
        expect(lastSnapshot.workingCopyCount).toBeGreaterThanOrEqual(1);
    });

    test('detects mutable ancestors and builds ancestor entries', async () => {
        await buildGraph(testRepo, [
            { label: 'c1', description: 'first ancestor commit', files: { 'file1.txt': 'c1 content\n' } },
            {
                label: 'c2',
                parents: ['c1'],
                description: 'second ancestor commit',
                files: { 'file2.txt': 'c2 content\n' },
            },
            { label: 'c3', parents: ['c2'], description: 'working copy' },
        ]);

        await scmModel.updateSnapshot({ reason: 'graph created' });

        const snapshot = scmModel.snapshot;
        expect(snapshot).toBeDefined();
        expect(snapshot?.ancestors.length).toBeGreaterThanOrEqual(2);
        expect(snapshot?.ancestors[0].prefix).toBe('@-1');
        expect(snapshot?.ancestors[0].isMutable).toBe(true);
        expect(snapshot?.ancestors[0].changes.length).toBeGreaterThan(0);
        expect(snapshot?.ancestors[0].changes.some((c) => c.path.includes('file2.txt'))).toBe(true);
        expect(snapshot?.parentMutable).toBe(true);
    });

    test('formats working copy label with description subject when described and omits it when empty', async () => {
        await buildGraph(testRepo, [
            { label: 'parent', description: 'parent commit', files: { 'file.txt': 'v1\n' } },
            { label: 'wc', parents: ['parent'], description: '', isCurrentWorkingCopy: true },
        ]);

        await scmModel.updateSnapshot({ reason: 'undescribed working copy' });
        const emptySnapshot = scmModel.snapshot;
        expect(emptySnapshot?.currentEntry).toBeDefined();
        expect(emptySnapshot?.workingCopyLabel).toMatch(/^Working Copy: [a-z]+$/);

        await scmModel.setDescription('feat: add working copy label\n\nDetailed body line');
        const describedSnapshot = scmModel.snapshot;
        expect(describedSnapshot?.workingCopyLabel).toMatch(/^Working Copy: [a-z]+ - feat: add working copy label$/);

        await scmModel.setDescription('   \n  ');
        const clearedSnapshot = scmModel.snapshot;
        expect(clearedSnapshot?.workingCopyLabel).toMatch(/^Working Copy: [a-z]+$/);
    });

    test('tracks selected commit IDs and updates description', async () => {
        scmModel.handleSelectionChange(['commit-1', 'commit-2']);
        expect(scmModel.getSelectedCommitIds()).toEqual(['commit-1', 'commit-2']);

        await scmModel.setDescription('New working copy message');
        const log = await scmModel.jj.getLog({ revision: '@' });
        expect(log[0]?.description?.trim()).toBe('New working copy message');
    });

    test('getOriginalResourceUri builds full-path jj-view URIs matching file:// paths on modified files', async () => {
        const sharedLines = Array.from({ length: 10 }, (_, idx) => `line ${idx + 1}`).join('\n');
        await buildGraph(testRepo, [
            {
                label: 'base',
                description: 'base commit',
                files: {
                    'src/mod.txt': 'v1\n',
                    'legacy/old_name.txt': sharedLines,
                },
            },
            {
                label: 'wc',
                parents: ['base'],
                isCurrentWorkingCopy: true,
                files: {
                    'src/mod.txt': 'v2\n',
                    'modern/new_name.txt': `${sharedLines}\nline 11`,
                },
            },
        ]);
        testRepo.deleteFile('legacy/old_name.txt');
        await scmModel.updateSnapshot({ reason: 'modified and renamed files' });

        const modFileUri = Uri.file(path.resolve(testRepo.path, 'src/mod.txt'));
        const modOrigUri = scmModel.getOriginalResourceUri(modFileUri);
        expect(modOrigUri).toBeDefined();
        expect(modOrigUri?.scheme).toBe('jj-view');
        expect(modOrigUri?.path).toBe(modFileUri.path);

        const renamedFileUri = Uri.file(path.resolve(testRepo.path, 'modern/new_name.txt'));
        const renamedOrigUri = scmModel.getOriginalResourceUri(renamedFileUri);
        expect(renamedOrigUri).toBeDefined();
        expect(renamedOrigUri?.scheme).toBe('jj-view');
        expect(renamedOrigUri?.path).toBe(Uri.file(path.resolve(testRepo.path, 'legacy/old_name.txt')).path);
    });

    test('disposes safely and unsubscribes all listeners', () => {
        expect(() => {
            scmModel.dispose();
            scmModel.dispose();
        }).not.toThrow();
    });

    test('setRepository switches repository, fires onDidChangeRepository, and refreshes snapshot', async () => {
        const secondTestRepo = new TestRepo();
        secondTestRepo.init();
        secondTestRepo.writeFile('second-repo.txt', 'from second repo\n');
        secondTestRepo.describe('Second repo working copy');

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(secondTestRepo.path));

        const secondManager = new JjRepositoryManager(registry, outputChannel, host);
        try {
            const secondRepo = await secondManager.maybeRegisterRepositoryContainingUri(Uri.file(secondTestRepo.path));
            if (!secondRepo) {
                throw new Error('Failed to register second repo');
            }

            const repoChanges: string[] = [];
            scmModel.onDidChangeRepository((r) => {
                repoChanges.push(r.rootUri.fsPath);
            });
            scmModel.handleSelectionChange(['commit-a']);

            const snapshotPromise = new Promise<ScmSnapshot>((resolve) => {
                scmModel.onDidChangeSnapshot((s) => {
                    if (s.description === 'Second repo working copy') {
                        resolve(s);
                    }
                });
            });

            scmModel.setRepository(secondRepo);

            expect(scmModel.repo).toBe(secondRepo);
            expect(scmModel.getSelectedCommitIds()).toEqual([]);
            expect(repoChanges).toHaveLength(1);
            expect(repoChanges[0]).toBeSameFsPath(secondRepo.rootUri.fsPath);

            const nextSnapshot = await snapshotPromise;
            expect(nextSnapshot.description).toBe('Second repo working copy');
            expect(nextSnapshot.workingCopyChanges.some((c) => c.path.includes('second-repo.txt'))).toBe(true);
        } finally {
            await secondManager.dispose();
        }
    });

    test('scopes cached and focused repository state per workspace root when sharing storage', async () => {
        const parentDir = new TestRepo();
        const carrotRepo = new TestRepo(`${parentDir.path}/carrot`);
        carrotRepo.init();
        const jjViewRepo = new TestRepo(`${parentDir.path}/jj-view`);
        jjViewRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        // 1. Parent workspace (/code) discovers both carrot and jj-view, focusing carrot (alphabetically first)
        const parentHost = new FakeHostEnvironment();
        parentHost.workspace.addFolder(Uri.file(parentDir.path));
        const parentManager = new JjRepositoryManager(registry, outputChannel, parentHost);

        // 2. Child workspace (/code/jj-view) shares the same backing storage (as in sidecar daemon state.json)
        const childHost = new FakeHostEnvironment();
        childHost.storage = parentHost.storage;
        childHost.workspace.addFolder(Uri.file(jjViewRepo.path));
        const childManager = new JjRepositoryManager(registry, outputChannel, childHost);

        try {
            const cRepo = await parentManager.maybeRegisterRepositoryContainingUri(Uri.file(carrotRepo.path));
            const jRepo = await parentManager.maybeRegisterRepositoryContainingUri(Uri.file(jjViewRepo.path));
            expect(cRepo).toBeDefined();
            expect(jRepo).toBeDefined();
            parentManager.setFocusedRepository(cRepo);

            const childRegistered = await childManager.maybeRegisterRepositoryContainingUri(Uri.file(jjViewRepo.path));
            expect(childRegistered).toBeDefined();
            childManager.setFocusedRepository(childRegistered);

            // 3. Reload parent workspace from shared storage: should still focus carrot, not jj-view
            const reloadedParentHost = new FakeHostEnvironment();
            reloadedParentHost.storage = parentHost.storage;
            reloadedParentHost.workspace.addFolder(Uri.file(parentDir.path));
            const reloadedParentManager = new JjRepositoryManager(registry, outputChannel, reloadedParentHost);
            try {
                await reloadedParentManager.restoreCachedRepositories();
                expect(reloadedParentManager.repositories.length).toBe(2);
                expect(reloadedParentManager.focusedRepository?.rootUri.fsPath).toBeSameFsPath(carrotRepo.path);
            } finally {
                await reloadedParentManager.dispose();
            }
        } finally {
            await childManager.dispose();
            await parentManager.dispose();
        }
    });
});
