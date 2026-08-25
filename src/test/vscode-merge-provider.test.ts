/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjMergeService } from '../jj-merge-service';
import { JjRepositoryManager } from '../jj-repository-manager';
import { Uri } from '../uri-utils';
import { VsCodeMergeContentProvider } from '../vscode/providers/vscode-merge-provider';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('VsCodeMergeContentProvider Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let provider: VsCodeMergeContentProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repositoryManager = new JjRepositoryManager(registry, outputChannel, workspaceState);

        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: Uri.file(testRepo.path),
        });
        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        const service = new JjMergeService(repo.jj);
        provider = new VsCodeMergeContentProvider(service);
    });

    afterEach(async () => {
        await repositoryManager.dispose();
    });

    test('handles missing query parameters gracefully', async () => {
        const uri = Uri.from({ scheme: 'jj-merge', path: '/test.txt' });
        const content = await provider.provideTextDocumentContent(uri);
        expect(content).toBe('');
    });

    test('clears cache without error', () => {
        expect(() => provider.clearCache()).not.toThrow();
        expect(() => provider.clearCache('some/path')).not.toThrow();
    });
});
