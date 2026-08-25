/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjRepositoryManager } from '../jj-repository-manager';
import { JjViewFsService } from '../jj-view-fs-service';
import { Uri } from '../uri-utils';
import { VsCodeViewFsProvider } from '../vscode/providers/vscode-view-fs-provider';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('VsCodeViewFsProvider Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let provider: VsCodeViewFsProvider;

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

        const service = new JjViewFsService(repositoryManager);
        provider = new VsCodeViewFsProvider(service);
    });

    afterEach(async () => {
        await repositoryManager.dispose();
    });

    test('reads file content for revision mode query', async () => {
        testRepo.writeFile('file.txt', 'hello from test\n');
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(testRepo.path)}&revision=@`,
        });

        const content = await provider.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello from test\n');
    });

    test('throws NoPermissions error on write', () => {
        expect(() => provider.writeFile()).toThrow();
    });
});
