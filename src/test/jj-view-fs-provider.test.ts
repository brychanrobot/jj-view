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
import { buildGraph, TestRepo } from './test-repo';
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
        const outsideUri = vscode.Uri.parse('jj-view:///outside/file.txt#root=/outside&revision=@');
        await expect(provider.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });

    it('readFile retrieves file content from a revision on a different chain', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'initial content' } },
            { label: 'chainA', parents: ['initial'], description: 'chainA', files: { 'f.txt': 'chain A content' } },
            {
                label: 'chainB',
                parents: ['initial'],
                description: 'chainB',
                files: { 'f.txt': 'chain B content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const uri = vscode.Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.chainA.changeId}`,
        });

        const bytes = await provider.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        expect(text).toBe('chain A content');
    });
});
