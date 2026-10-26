/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { autoCleanup, ScopedTestRepo } from './scoped-helpers';
import { createMockLogOutputChannel } from './test-utils';

describe('JjRepositoryManager Unit Tests', () => {
    it('registers workspace root repository immediately before findFiles resolves', async () => {
        using mainRepo = new ScopedTestRepo();
        mainRepo.init();

        const subRepoPath = path.join(mainRepo.path, 'nested-subrepo');
        using subRepo = new ScopedTestRepo(subRepoPath);
        subRepo.init();

        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(mainRepo.path));

        let resolveFindFiles!: (uris: Uri[]) => void;
        const findFilesPromise = new Promise<Uri[]>((resolve) => {
            resolveFindFiles = resolve;
        });

        vi.spyOn(host.workspace, 'findFiles').mockReturnValue(findFilesPromise);

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel();
        await using manager = autoCleanup(new JjRepositoryManager(registry, outputChannel, host));

        const openedRoots: string[] = [];
        manager.onDidOpenRepository((repo) => {
            openedRoots.push(repo.rootUri.fsPath);
        });

        const scanPromise = manager.scanForRepositories();

        // Wait for the primary workspace root repository to be registered while findFiles is still pending
        await vi.waitFor(() => {
            expect(manager.repositories.map((r) => r.rootUri.fsPath)).toEqual([mainRepo.path]);
        });
        expect(openedRoots).toEqual([mainRepo.path]);
        expect(manager.focusedRepository?.rootUri.fsPath).toBeSameFsPath(mainRepo.path);

        // Now resolve findFiles with the nested sub-repository
        resolveFindFiles([Uri.file(path.join(subRepo.path, '.jj', 'working_copy', 'type'))]);
        await scanPromise;

        expect(manager.repositories.map((r) => r.rootUri.fsPath).sort()).toEqual([mainRepo.path, subRepo.path].sort());
        registry.dispose();
    });

    it('calls system.addAllowedRoot when discovering an enclosing repository root for a child workspace folder and when restoring from cache', async () => {
        using parentRepo = new ScopedTestRepo();
        parentRepo.init();

        const childDir = path.join(parentRepo.path, 'packages', 'subpkg');
        fs.mkdirSync(childDir, { recursive: true });

        const host = new FakeHostEnvironment();
        const addAllowedRootSpy = vi.fn().mockResolvedValue(undefined);
        host.system.addAllowedRoot = addAllowedRootSpy;
        host.workspace.addFolder(Uri.file(childDir));

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel();
        const manager1 = new JjRepositoryManager(registry, outputChannel, host);

        const registered = await manager1.maybeRegisterWorkspaceRoot(Uri.file(childDir));
        expect(registered?.rootUri.fsPath).toBeSameFsPath(parentRepo.path);
        expect(addAllowedRootSpy).toHaveBeenCalledWith(parentRepo.path);
        await manager1.dispose();

        // Simulate reload with a fresh manager sharing the same storage
        addAllowedRootSpy.mockClear();
        await using manager2 = autoCleanup(new JjRepositoryManager(registry, outputChannel, host));
        await manager2.restoreCachedRepositories();

        expect(addAllowedRootSpy).toHaveBeenCalledWith(parentRepo.path);
        expect(manager2.repositories).toHaveLength(1);
        expect(manager2.repositories[0].rootUri.fsPath).toBeSameFsPath(parentRepo.path);

        registry.dispose();
    });

    it('preserves repositories dynamically registered while findFiles is in flight and respects maybeRegisterWorkspaceRoot when autoRepositoryDetection is false', async () => {
        using mainRepo = new ScopedTestRepo();
        mainRepo.init();

        using containerDir = new ScopedTestRepo();
        const subRepoPath = path.join(containerDir.path, 'nested-subrepo');
        using subRepo = new ScopedTestRepo(subRepoPath);
        subRepo.init();

        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(mainRepo.path));
        host.workspace.addFolder(Uri.file(containerDir.path));

        let resolveFindFiles!: (uris: Uri[]) => void;
        const findFilesPromise = new Promise<Uri[]>((resolve) => {
            resolveFindFiles = resolve;
        });
        vi.spyOn(host.workspace, 'findFiles').mockReturnValue(findFilesPromise);

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel();
        await using manager = autoCleanup(new JjRepositoryManager(registry, outputChannel, host));

        const scanPromise = manager.scanForRepositories();
        try {
            // Wait for Stage 1 to register mainRepo while findFiles is still pending
            await vi.waitFor(() => {
                expect(manager.repositories).toHaveLength(1);
            });

            // Dynamically register subRepo while findFiles is in flight (even if findFiles returns empty)
            await manager.maybeRegisterRepositoryContainingUri(Uri.file(path.join(subRepo.path, 'file.txt')));
            expect(manager.repositories).toHaveLength(2);
        } finally {
            // Resolve findFiles with empty array (simulating MaxDirs truncation)
            resolveFindFiles([]);
            await scanPromise;
        }

        // Dynamically registered subRepo must not be disposed by Stage 2
        expect(manager.repositories).toHaveLength(2);
        expect(manager.repositories.map((r) => r.rootUri.fsPath).sort()).toEqual([mainRepo.path, subRepo.path].sort());

        // Verify maybeRegisterWorkspaceRoot works even when autoRepositoryDetection is false
        await manager.clear();
        host.config.set('autoRepositoryDetection', false);
        const rootRepo = await manager.maybeRegisterWorkspaceRoot(Uri.file(mainRepo.path));
        expect(rootRepo?.rootUri.fsPath).toBeSameFsPath(mainRepo.path);

        registry.dispose();
    });
});
