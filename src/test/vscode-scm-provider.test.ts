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
        const host = new FakeHostEnvironment();
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
    });

    afterEach(async () => {
        scmProvider.dispose();
        await repositoryManager.dispose();
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

    test('disposes all VS Code resources cleanly', () => {
        expect(() => {
            scmProvider.dispose();
            scmProvider.dispose();
        }).not.toThrow();
    });
});
