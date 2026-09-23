/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeProvider } from '../core/code-forge-provider';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { EventEmitter } from '../core/host/events';
import { JjRepository } from '../core/jj-repository';
import type { CodeForgeChangeInfo } from '../core/jj-types';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

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

    test('refresh() preserves code forge cache across refreshes', async () => {
        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
            host,
        );

        const clearForgeSpy = vi.spyOn(jjRepo.codeForge, 'clearCache');
        await jjRepo.refresh({ reason: 'manual' });
        await jjRepo.refresh({ reason: 'focus refresh', forceSnapshot: true });

        expect(clearForgeSpy).not.toHaveBeenCalled();
    });

    test('cached change info is preserved when repository refreshes', async () => {
        const registry = new CodeForgeRegistry();
        const fakeChange = createMock<CodeForgeChangeInfo>({
            id: 'change-1',
            number: 101,
            displayLabel: 'Change 101',
            status: 'NEW',
        });
        const cache = new Map<string, CodeForgeChangeInfo>([['change-1', fakeChange]]);
        const mockProvider = createMock<CodeForgeProvider>({
            id: 'mock-provider',
            detect: async () => true,
            onDidUpdate: new EventEmitter<void>().event,
            getCachedChangeInfo: vi.fn((id: string) => cache.get(id)),
            fetchStatuses: vi.fn().mockResolvedValue(false),
            clearCache: vi.fn(() => cache.clear()),
            activate: () => {},
            deactivate: () => {},
        });
        registry.register({ id: 'mock-provider', create: () => mockProvider });

        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            registry,
            createMockLogOutputChannel(),
            host,
        );

        await jjRepo.codeForge.detectActiveProvider(true);
        expect(jjRepo.codeForge.activeProvider?.id).toBe('mock-provider');

        // Verify initial cache lookup
        const initial = jjRepo.codeForge.activeProvider?.getCachedChangeInfo('change-1');
        expect(initial).toEqual(fakeChange);

        // Perform manual and focus refreshes
        await jjRepo.refresh({ reason: 'manual' });
        await jjRepo.refresh({ reason: 'focus refresh', forceSnapshot: true });

        // Ensure clearCache was not invoked and cached change info remains intact
        expect(mockProvider.clearCache).not.toHaveBeenCalled();
        const afterRefresh = jjRepo.codeForge.activeProvider?.getCachedChangeInfo('change-1');
        expect(afterRefresh).toEqual(fakeChange);
    });
});
