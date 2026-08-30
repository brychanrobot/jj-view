/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepository } from '../core/jj-repository';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('JjRepository.refresh error handling', () => {
    let repo: TestRepo;
    let jjRepo: JjRepository;
    let host: FakeHostEnvironment;

    beforeEach(() => {
        host = new FakeHostEnvironment();
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
            host,
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
            host,
        );

        await expect(jjRepo.refresh({ forceSnapshot: true })).resolves.toBeUndefined();
    });

    test('refresh() on disposed repository resolves immediately', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
            host,
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
            host,
        );

        const refreshPromise = jjRepo.refresh({ forceSnapshot: true });
        expect(jjRepo.activeRefresh).toBeDefined();

        await jjRepo.dispose();
        await expect(refreshPromise).resolves.toBeUndefined();
        expect(jjRepo.activeRefresh).toBeUndefined();
    });

    test('dispose() cancels pending background debounce timer immediately', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
            host,
        );

        // Trigger a background file save event to start a debounce timer
        host.documents.fireDidSaveDocument(Uri.file(path.join(repo.path, 'file.txt')));
        expect(jjRepo.activeRefresh).toBeDefined();

        await jjRepo.dispose();
        expect(jjRepo.activeRefresh).toBeUndefined();
    });

    test('dispose() cleans up onDidStatusChange event emitter', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
            host,
        );

        const statusListener = vi.fn();
        jjRepo.onDidStatusChange(statusListener);

        await jjRepo.dispose();

        // In JjRepository, listeners are cleaned up and events are no longer fired after dispose
        expect(statusListener).not.toHaveBeenCalled();
    });
});
