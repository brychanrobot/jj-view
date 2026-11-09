/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { CodeForgeRegistry } from '../core/code-forge-registry';
import { NodeHostSystem } from '../core/host/node-host-system';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('VsCodeScmProvider Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let scmProvider: VsCodeScmProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment(
            new NodeHostSystem({
                watcher: {
                    watch: async () => ({
                        unsubscribe: async () => {},
                    }),
                },
            }),
        );
        host.workspace.addFolder(Uri.file(testRepo.path));

        repositoryManager = new JjRepositoryManager(registry, outputChannel, host);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        const extensionContext = createMock<vscode.ExtensionContext>({
            subscriptions: [],
        });

        scmProvider = new VsCodeScmProvider(extensionContext, repo, outputChannel, repositoryManager);
        await repo.watcher.dispose();
        await repo.activeRefresh;
    });

    afterEach(async () => {
        scmProvider.dispose();
        await repositoryManager.dispose();
        await testRepo.dispose();
    });

    test('creates vscode.SourceControl and resource groups', () => {
        expect(vscode.scm.createSourceControl).toHaveBeenCalled();
        expect(scmProvider.sourceControl).toBeDefined();
    });

    test('provides original resource for modified file', async () => {
        await buildGraph(testRepo, [
            {
                label: 'parent',
                description: 'parent commit',
                files: { 'file.txt': 'initial\n' },
            },
            {
                label: 'workingCopy',
                parents: ['parent'],
                description: 'working copy',
                files: { 'file.txt': 'modified\n' },
                isCurrentWorkingCopy: true,
            },
        ]);
        await scmProvider.refresh({ forceSnapshot: true });

        const originalUri = scmProvider.provideOriginalResource(Uri.file(`${testRepo.path}/file.txt`));
        expect(originalUri).toBeDefined();
        if (originalUri && 'scheme' in originalUri) {
            expect(originalUri.scheme).toBe('jj-view');
        }
    });

    test('preserves unsaved inputBox edits across commit_id changes on same change_id, but updates on jj describe and jj new', async () => {
        await buildGraph(testRepo, [
            {
                label: 'parent',
                description: 'parent commit',
                files: { 'file.txt': 'v1\n' },
            },
            {
                label: 'workingCopy',
                parents: ['parent'],
                description: 'initial wc',
                files: { 'file.txt': 'v1\n' },
                isCurrentWorkingCopy: true,
            },
        ]);
        await scmProvider.refresh({ forceSnapshot: true });

        expect(scmProvider.inputBoxValue).toBe('initial wc');
        const initialChangeId = scmProvider.scmModel.currentEntry?.change_id;
        const initialCommitId = scmProvider.scmModel.currentEntry?.commit_id;
        expect(initialChangeId).toBeDefined();
        expect(initialCommitId).toBeDefined();

        // Simulate unsaved user edits in the SCM input box while a working-copy file save
        // triggers a snapshot that advances commit_id on the same change_id.
        scmProvider.sourceControl.inputBox.value = 'unsaved user draft';
        testRepo.writeFile('file.txt', 'v2\n');
        await scmProvider.refresh({ forceSnapshot: true });

        expect(scmProvider.scmModel.currentEntry?.change_id).toBe(initialChangeId);
        expect(scmProvider.scmModel.currentEntry?.commit_id).not.toBe(initialCommitId);
        expect(scmProvider.inputBoxValue).toBe('unsaved user draft');

        // When the input box holds an unwrapped draft and `jj describe` updates the description
        // on the same change_id (e.g. Ctrl+S with formatDescriptionOnSave), inputBox and
        // _lastKnownDescription both update to the formatted description.
        scmProvider.sourceControl.inputBox.value = 'unwrapped draft text';
        testRepo.describe('wrapped\ndraft text');
        await scmProvider.refresh({ reason: 'after describe' });
        expect(scmProvider.scmModel.currentEntry?.change_id).toBe(initialChangeId);
        expect(scmProvider.inputBoxValue).toBe('wrapped\ndraft text');

        // A subsequent external `jj describe` on the same change_id also updates inputBox.value
        // (confirming _lastKnownDescription stayed in sync).
        testRepo.describe('updated wc');
        await scmProvider.refresh();
        expect(scmProvider.inputBoxValue).toBe('updated wc');

        // If the user edits inputBox again and an 'after describe' refresh formats it back to the
        // unchanged description, inputBox.value still syncs to the saved description.
        scmProvider.sourceControl.inputBox.value = 'unwrapped draft re-typed';
        await scmProvider.refresh({ reason: 'after describe' });
        expect(scmProvider.inputBoxValue).toBe('updated wc');

        // Saving another working-copy file (new commit_id, same change_id and unchanged description)
        // STILL preserves unsaved draft text in inputBox.value.
        scmProvider.sourceControl.inputBox.value = 'second unsaved draft';
        testRepo.writeFile('file.txt', 'v3\n');
        await scmProvider.refresh({ forceSnapshot: true });
        expect(scmProvider.scmModel.currentEntry?.change_id).toBe(initialChangeId);
        expect(scmProvider.inputBoxValue).toBe('second unsaved draft');

        // Switching to a new change_id updates the input box even if user had unsaved text.
        scmProvider.sourceControl.inputBox.value = 'stale draft before new';
        testRepo.new([], 'second wc');
        await scmProvider.refresh();
        expect(scmProvider.scmModel.currentEntry?.change_id).not.toBe(initialChangeId);
        expect(scmProvider.inputBoxValue).toBe('second wc');

        // Clearing inputBox to '' when @ has a non-empty saved description is preserved
        // across working-copy file-save snapshots.
        scmProvider.sourceControl.inputBox.value = '';
        testRepo.writeFile('file.txt', 'v4\n');
        await scmProvider.refresh({ forceSnapshot: true });
        expect(scmProvider.inputBoxValue).toBe('');

        // Describing an unrelated revision (after describe:<other>) preserves @'s unsaved draft.
        scmProvider.sourceControl.inputBox.value = 'unsaved draft during ancestor describe';
        await scmProvider.refresh({ reason: 'after describe:other-ancestor' });
        expect(scmProvider.inputBoxValue).toBe('unsaved draft during ancestor describe');
    });

    test('disposes all VS Code resources cleanly', () => {
        expect(() => {
            scmProvider.dispose();
            scmProvider.dispose();
        }).not.toThrow();
    });
});
