/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { JjViewFsService } from '../core/jj-view-fs-service';
import { Uri } from '../core/uri-utils';
import { VsCodeViewFsProvider } from '../vscode/providers/vscode-view-fs-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

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
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(testRepo.path));

        repositoryManager = new JjRepositoryManager(registry, outputChannel, host);

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
