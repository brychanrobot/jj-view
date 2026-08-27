/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjRepositoryManager } from '../jj-repository-manager';
import { JjViewFsService } from '../jj-view-fs-service';
import { Uri } from '../uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('JjViewFsService Unit Tests', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let service: JjViewFsService;

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

        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        service = new JjViewFsService(repoManager);
    });

    afterEach(async () => {
        await repoManager.dispose();
        repo.dispose();
    });

    it('throws error when no repository is found', async () => {
        const outsideUri = Uri.parse('jj-view:///outside/file.txt#root=/outside&revision=@');
        await expect(service.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });

    it('reads file content at a specific revision', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'version 1' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        const bytes = await service.readFile(uri);
        expect(Buffer.from(bytes).toString('utf8')).toBe('version 1');
    });

    it('invalidates cache and emits onDidChangeFile', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'initial content' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        await service.readFile(uri);

        let firedUris: Uri[] = [];
        service.onDidChangeFile((uris) => {
            firedUris = uris;
        });

        const invalidated = service.invalidateCache();
        expect(invalidated.length).toBe(1);
        expect(firedUris.length).toBe(1);
        expect(firedUris[0].toString()).toBe(uri.toString());
    });
});
