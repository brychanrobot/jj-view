/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjRepositoryManager } from '../jj-repository-manager';
import { JjViewFsService } from '../jj-view-fs-service';
import { Uri } from '../uri-utils';
import { VsCodeViewFsProvider } from '../vscode/providers/vscode-view-fs-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VsCodeViewFsProvider', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let provider: VsCodeViewFsProvider;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, host);

        // Register the real repository
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        const service = new JjViewFsService(repoManager);
        provider = new VsCodeViewFsProvider(service);
    });

    afterEach(async () => {
        await repoManager.dispose();
    });

    it('readFile throws FileSystemError.Unavailable when no repository is found', async () => {
        const outsideUri = Uri.parse('jj-view:///outside/file.txt#root=/outside&revision=@');
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

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.chainA.changeId}`,
        });

        const bytes = await provider.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        expect(text).toBe('chain A content');
    });
});
