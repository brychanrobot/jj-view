/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjMergeService } from '../jj-merge-service';
import { JjRepositoryManager } from '../jj-repository-manager';
import { Uri } from '../uri-utils';
import { VsCodeMergeContentProvider } from '../vscode/providers/vscode-merge-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VsCodeMergeContentProvider', () => {
    let repo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let provider: VsCodeMergeContentProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        repo = new TestRepo();
        repo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repositoryManager = new JjRepositoryManager(registry, outputChannel, host);

        const registeredRepo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        if (!registeredRepo) {
            throw new Error('Failed to register repo in test');
        }

        const service = new JjMergeService(registeredRepo.jj);
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
