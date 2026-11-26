/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { CodeForgeRegistry } from '../core/code-forge-registry';
import { NodeHostSystem } from '../core/host/node-host-system';
import { ScmContextValue } from '../core/jj-context-keys';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('VsCodeScmProvider Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let host: FakeHostEnvironment;
    let scmProvider: VsCodeScmProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        host = new FakeHostEnvironment(
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

    test('honors editableMutableDiffs setting and rebuilds ancestor resource states on config change without clobbering inputBox', async () => {
        await buildGraph(testRepo, [
            { label: 'parent', description: 'mutable parent', files: { 'ancestor.txt': 'v1\n' } },
            { label: 'wc', description: 'working copy', parents: ['parent'], files: { 'wc.txt': 'w1\n' } },
        ]);

        await scmProvider.refresh({ forceSnapshot: true });

        const getGroups = () =>
            vi
                .mocked(scmProvider.sourceControl.createResourceGroup)
                .mock.results.filter(
                    (r): r is { type: 'return'; value: vscode.SourceControlResourceGroup } => r.type === 'return',
                )
                .map((r) => r.value);

        // Default (true): mutable ancestor starts editable (jj-edit)
        await vi.waitFor(() => {
            const ancestorGroup = getGroups().find((g) => g.id === 'ancestor-0');
            expect(ancestorGroup?.resourceStates[0]?.resourceUri.scheme).toBe('jj-edit');
        });

        scmProvider.sourceControl.inputBox.value = 'unsaved wc draft';
        // Toggle true -> false purely via onDidChangeConfiguration without calling refresh()
        await host.config.update('jj-view.editableMutableDiffs', false);

        await vi.waitFor(() => {
            const ancestorGroup = getGroups().find((g) => g.id === 'ancestor-0');
            expect(ancestorGroup?.resourceStates[0]?.resourceUri.scheme).toBe('jj-view');
        });

        const ancestorGroupReadOnly = getGroups().find((g) => g.id === 'ancestor-0');
        const ancestorStateReadOnly = ancestorGroupReadOnly?.resourceStates[0];
        expect(ancestorStateReadOnly?.resourceUri.scheme).toBe('jj-view');
        expect(ancestorStateReadOnly?.contextValue).toContain('jj.resource.allowSquashIntoParent');

        const wcGroup = getGroups().find((g) => g.id === ScmContextValue.WorkingCopyGroup);
        expect(wcGroup?.resourceStates[0]?.resourceUri.scheme).toBe('file');
        expect(scmProvider.sourceControl.inputBox.value).toBe('unsaved wc draft');

        // Toggling false -> true rebuilds ancestor resources back to jj-edit
        // without clobbering the user's unsaved SCM description draft
        await host.config.update('jj-view.editableMutableDiffs', true);
        await vi.waitFor(() => {
            const ancestorGroup = getGroups().find((g) => g.id === 'ancestor-0');
            expect(ancestorGroup?.resourceStates[0]?.resourceUri.scheme).toBe('jj-edit');
        });
        expect(scmProvider.sourceControl.inputBox.value).toBe('unsaved wc draft');
    });

    test('uses repo-relative resourceUri for nested ancestor paths and decorates both resourceUri and rightUri', async () => {
        await buildGraph(testRepo, [
            { label: 'base', description: 'base commit', files: { 'README.md': 'base\n' } },
            {
                label: 'parent',
                description: 'add nested file',
                parents: ['base'],
                files: { 'packages/core/src/ancestor.ts': 'export const v = 1;\n' },
            },
            {
                label: 'wc',
                description: 'modify nested file in wc',
                parents: ['parent'],
                files: { 'packages/core/src/ancestor.ts': 'export const v = 2;\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await scmProvider.refresh({ forceSnapshot: true });

        const getGroups = () =>
            vi
                .mocked(scmProvider.sourceControl.createResourceGroup)
                .mock.results.filter(
                    (r): r is { type: 'return'; value: vscode.SourceControlResourceGroup } => r.type === 'return',
                )
                .map((r) => r.value);

        let ancestorState: vscode.SourceControlResourceState | undefined;
        let wcState: vscode.SourceControlResourceState | undefined;
        await vi.waitFor(() => {
            const ancestorGroup = getGroups().find((g) => g.id === 'ancestor-0');
            const wcGroup = getGroups().find((g) => g.id === ScmContextValue.WorkingCopyGroup);
            ancestorState = ancestorGroup?.resourceStates[0];
            wcState = wcGroup?.resourceStates[0];
            expect(ancestorState).toBeDefined();
            expect(wcState).toBeDefined();
        });

        if (!ancestorState || !wcState) {
            throw new Error('Expected ancestorState and wcState to be defined');
        }

        expect(ancestorState.resourceUri.scheme).toBe('jj-edit');
        expect(ancestorState.resourceUri.path).toBe('/packages/core/src/ancestor.ts');
        expect(ancestorState.resourceUri.path).not.toContain(path.basename(testRepo.path));

        const diffArgs = ancestorState.command?.arguments;
        const leftUri = diffArgs && Uri.isUri(diffArgs[0]) ? diffArgs[0] : undefined;
        const rightUri = diffArgs && Uri.isUri(diffArgs[1]) ? diffArgs[1] : undefined;
        if (!leftUri || !rightUri) {
            throw new Error('Expected command arguments to contain leftUri and rightUri');
        }
        expect(leftUri.path).toBe(rightUri.path);
        expect(rightUri.path.endsWith('/packages/core/src/ancestor.ts')).toBe(true);
        expect(rightUri.fsPath).toContain('packages');

        const token = createMock<vscode.CancellationToken>();
        const ancestorResourceDec = await scmProvider.decorationProvider.provideFileDecoration(
            ancestorState.resourceUri,
            token,
        );
        expect(ancestorResourceDec?.badge).toBe('A');

        const ancestorRightDec = await scmProvider.decorationProvider.provideFileDecoration(rightUri, token);
        expect(ancestorRightDec?.badge).toBe('A');

        const wcResourceDec = await scmProvider.decorationProvider.provideFileDecoration(wcState.resourceUri, token);
        expect(wcResourceDec?.badge).toBe('M');
    });

    test('disposes all VS Code resources cleanly', () => {
        expect(() => {
            scmProvider.dispose();
            scmProvider.dispose();
        }).not.toThrow();
    });
});
