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

const mockOnDidSaveTextDocument = vi.fn();

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock({
        workspace: {
            onDidSaveTextDocument: (...args: unknown[]) => mockOnDidSaveTextDocument(...args),
        },
    });
});

describe('JjRepository.refresh error handling', () => {
    let repo: TestRepo;
    let jjRepo: JjRepository;

    beforeEach(() => {
        mockOnDidSaveTextDocument.mockReturnValue({ dispose: () => {} });
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

    test('dispose() cancels pending background debounce timer immediately', async () => {
        let saveListener: ((doc: { uri: { scheme: string; fsPath: string } }) => void) | undefined;
        mockOnDidSaveTextDocument.mockImplementation(
            (listener: (doc: { uri: { scheme: string; fsPath: string } }) => void) => {
                saveListener = listener;
                return { dispose: () => {} };
            },
        );

        jjRepo = new JjRepository(
            Uri.file(repo.path),
            path.join(repo.path, '.jj', 'repo'),
            new CodeForgeRegistry(),
            createMockLogOutputChannel(),
        );

        // Trigger a background file save event to start a debounce timer
        saveListener?.({
            uri: Uri.file(path.join(repo.path, 'file.txt')),
        });
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
        );

        const statusListener = vi.fn();
        jjRepo.onDidStatusChange(statusListener);

        await jjRepo.dispose();

        // Refresh on disposed repository should not fire listener
        await jjRepo.refresh({ forceSnapshot: true });
        expect(statusListener).not.toHaveBeenCalled();
    });
});
