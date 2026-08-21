/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjRepository } from '../jj-repository';
import { Uri } from '../uri-utils';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

describe('JjRepository.refresh error handling', () => {
    let repo: TestRepo;
    let jjRepo: JjRepository;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
    });

    afterEach(async () => {
        if (jjRepo) {
            await jjRepo.dispose();
        }
    });

    test('refresh() propagates error when jj operations reject on invalid repo binary/path', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
            '/non/existent/jj/binary/path',
        );

        await expect(jjRepo.refresh({ forceSnapshot: true })).rejects.toThrow();
    });

    test('refresh() resolves successfully on valid repo', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
        );

        await expect(jjRepo.refresh({ forceSnapshot: true })).resolves.toBeUndefined();
    });

    test('refresh() on disposed repository resolves immediately', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
        );

        await jjRepo.dispose();
        await expect(jjRepo.refresh({ forceSnapshot: true })).resolves.toBeUndefined();
    });

    test('dispose() waits for active in-flight refresh to complete cleanly', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
        );

        const refreshPromise = jjRepo.refresh({ forceSnapshot: true });
        expect(jjRepo.activeRefresh).toBeDefined();

        await jjRepo.dispose();
        await expect(refreshPromise).resolves.toBeUndefined();
        expect(jjRepo.activeRefresh).toBeUndefined();
    });
});
