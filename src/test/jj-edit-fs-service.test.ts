/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Uri } from '../uri-utils';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjEditFsService } from '../jj-edit-fs-service';
import { JjRepositoryManager } from '../jj-repository-manager';
import { buildGraph, TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('JjEditFsService Unit Tests', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let service: JjEditFsService;

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

        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: Uri.file(repo.path),
        });
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        service = new JjEditFsService(repoManager);
    });

    afterEach(async () => {
        await repoManager.dispose();
        repo.dispose();
    });

    it('reads file from historical revision', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'hello from initial' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        const content = await service.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello from initial');
    });

    it('writes file changes into revision atomically', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'original' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        await service.writeFile(uri, Buffer.from('modified content\n', 'utf8'));

        const updated = await service.readFile(uri);
        expect(Buffer.from(updated).toString('utf8')).toBe('modified content\n');
    });
});
