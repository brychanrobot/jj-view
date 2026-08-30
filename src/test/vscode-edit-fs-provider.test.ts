/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjEditFsService } from '../core/jj-edit-fs-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { VsCodeEditFsProvider } from '../vscode/providers/vscode-edit-fs-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VsCodeEditFsProvider Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let provider: VsCodeEditFsProvider;

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

        const service = new JjEditFsService(repositoryManager);
        provider = new VsCodeEditFsProvider(service);
    });

    afterEach(async () => {
        await repositoryManager.dispose();
    });

    test('reads and writes file in working copy', async () => {
        testRepo.writeFile('edit-test.txt', 'initial content\n');
        const uri = Uri.from({
            scheme: 'jj-edit',
            path: '/edit-test.txt',
            fragment: `root=${encodeURIComponent(testRepo.path)}&revision=@`,
        });

        const content = await provider.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('initial content\n');

        await provider.writeFile(uri, Buffer.from('new edited content\n', 'utf8'));
        const updatedContent = await provider.readFile(uri);
        expect(Buffer.from(updatedContent).toString('utf8')).toBe('new edited content\n');
    });
});
