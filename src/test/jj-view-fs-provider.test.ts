/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjRepositoryManager } from '../jj-repository-manager';
import { JjViewFileSystemProvider } from '../jj-view-fs-provider';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('JjViewFileSystemProvider', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let provider: JjViewFileSystemProvider;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, workspaceState);

        // Register the real repository
        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: vscode.Uri.file(repo.path),
        });
        await repoManager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(repo.path));

        provider = new JjViewFileSystemProvider(repoManager);
    });

    afterEach(async () => {
        await repoManager.dispose();
    });

    it('readFile throws FileSystemError.Unavailable when no repository is found', async () => {
        const outsideUri = vscode.Uri.parse('jj-view:///outside/file.txt?revision=@');
        await expect(provider.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });
});
