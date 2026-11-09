/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { autoCleanup, ScopedSymlink, ScopedTempDir, ScopedTestRepo } from './scoped-helpers';
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
        try {
            // Wait for the primary workspace root repository to be registered while findFiles is still pending
            await vi.waitFor(() => {
                expect(manager.repositories).toHaveLength(1);
                expect(manager.repositories[0].rootUri.fsPath).toBeSameFsPath(mainRepo.path);
            });
            expect(openedRoots).toHaveLength(1);
            expect(openedRoots[0]).toBeSameFsPath(mainRepo.path);
            expect(manager.focusedRepository?.rootUri.fsPath).toBeSameFsPath(mainRepo.path);
        } finally {
            // Now resolve findFiles with the nested sub-repository
            resolveFindFiles([Uri.file(path.join(subRepo.path, '.jj', 'working_copy', 'type'))]);
            await scanPromise;
        }

        expect(manager.repositories.map((r) => r.rootUri.fsPath).sort()).toEqual(
            [Uri.file(mainRepo.path).fsPath, Uri.file(subRepo.path).fsPath].sort(),
        );
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
        expect(manager.repositories.map((r) => r.rootUri.fsPath).sort()).toEqual(
            [Uri.file(mainRepo.path).fsPath, Uri.file(subRepo.path).fsPath].sort(),
        );

        // Verify maybeRegisterWorkspaceRoot works even when autoRepositoryDetection is false
        await manager.clear();
        host.config.set('autoRepositoryDetection', false);
        const rootRepo = await manager.maybeRegisterWorkspaceRoot(Uri.file(mainRepo.path));
        expect(rootRepo?.rootUri.fsPath).toBeSameFsPath(mainRepo.path);

        registry.dispose();
    });

    it('skips findFiles for .citc root and .citc child workspace folders while still scanning non-.citc folders', async () => {
        using citcRepo = new ScopedTestRepo();
        citcRepo.init();
        fs.mkdirSync(path.join(citcRepo.path, '.citc'), { recursive: true });

        using citcRepo2 = new ScopedTestRepo();
        citcRepo2.init();
        fs.mkdirSync(path.join(citcRepo2.path, '.citc'), { recursive: true });
        const citcChildFolder = path.join(citcRepo2.path, 'subproject');
        fs.mkdirSync(citcChildFolder, { recursive: true });

        using nonJjCitcRoot = new ScopedTempDir(path.join(os.tmpdir(), 'jj-citc-nonjj-'));
        fs.mkdirSync(path.join(nonJjCitcRoot.path, '.citc'), { recursive: true });
        const nonJjCitcChild = path.join(nonJjCitcRoot.path, 'subproject');
        fs.mkdirSync(nonJjCitcChild, { recursive: true });

        using normalContainer = new ScopedTestRepo();
        const subRepoPath = path.join(normalContainer.path, 'nested-subrepo');
        using subRepo = new ScopedTestRepo(subRepoPath);
        subRepo.init();

        const host = new FakeHostEnvironment();
        host.system = {
            ...host.system,
            platform: 'linux',
            watcher: { watch: async () => ({ unsubscribe: async () => {} }) },
        };
        host.workspace.addFolder(Uri.file(citcRepo.path));
        host.workspace.addFolder(Uri.file(citcChildFolder));
        host.workspace.addFolder(Uri.file(nonJjCitcChild));
        host.workspace.addFolder(Uri.file(normalContainer.path));

        const canonicalRealPath = (p: string) => {
            const real = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
            return process.platform === 'win32' ? real.toLowerCase() : real;
        };

        const findFilesSpy = vi.spyOn(host.workspace, 'findFiles').mockImplementation(async (_glob, baseUri) => {
            if (baseUri && canonicalRealPath(baseUri.fsPath) === canonicalRealPath(normalContainer.path)) {
                return [Uri.file(path.join(subRepo.path, '.jj', 'working_copy', 'type'))];
            }
            return [];
        });

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel();
        const manager = new JjRepositoryManager(registry, outputChannel, host);
        try {
            await manager.scanForRepositories();

            expect(findFilesSpy).toHaveBeenCalledTimes(1);
            expect(findFilesSpy.mock.calls[0]?.[1]?.fsPath).toBeSameFsPath(normalContainer.path);

            expect(manager.repositories).toHaveLength(3);
            expect(manager.repositories.map((r) => fs.realpathSync(r.rootUri.fsPath))).toEqual(
                expect.arrayContaining([
                    expect.toBeSameFsPath(fs.realpathSync(citcRepo.path)),
                    expect.toBeSameFsPath(fs.realpathSync(citcRepo2.path)),
                    expect.toBeSameFsPath(fs.realpathSync(subRepo.path)),
                ]),
            );
        } finally {
            await manager.dispose();
            registry.dispose();
        }
    });

    it('stops upward .citc discovery on sandbox access-denied errors, UNC share roots, and win32 hosts', async () => {
        const host = new FakeHostEnvironment();
        host.system = {
            ...host.system,
            platform: 'linux',
            watcher: { watch: async () => ({ unsubscribe: async () => {} }) },
        };
        vi.spyOn(host.system.process, 'execFile').mockRejectedValue(new Error('not a jj repo'));
        vi.spyOn(host.system.fs, 'realpath').mockImplementation(async (p) => p);
        if (host.system.fs.realpathSync) {
            vi.spyOn(host.system.fs, 'realpathSync').mockImplementation((p) => p);
        }
        vi.spyOn(host.system.fs, 'exists').mockResolvedValue(false);

        const lstatPaths: string[] = [];
        vi.spyOn(host.system.fs, 'lstat').mockImplementation(async (p) => {
            lstatPaths.push(p);
            if (p.startsWith('/tmp/sandboxed-parent/.citc')) {
                throw new Error('access denied: path is outside allowed sandbox');
            }
            throw new Error(`ENOENT: ${p}`);
        });

        host.workspace.addFolder(Uri.file('//server/share/subproject'));
        host.workspace.addFolder(Uri.file('/tmp/sandboxed-parent/normal-ws'));

        const findFilesSpy = vi.spyOn(host.workspace, 'findFiles').mockResolvedValue([]);

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel();
        const manager = new JjRepositoryManager(registry, outputChannel, host);
        try {
            await manager.scanForRepositories();

            expect(findFilesSpy).toHaveBeenCalledTimes(2);
            const scannedPaths = findFilesSpy.mock.calls.map((call) => call[1]?.fsPath ?? '');
            expect(scannedPaths).toHaveLength(2);
            expect(scannedPaths[0]).toBeSameFsPath('//server/share/subproject');
            expect(scannedPaths[1]).toBeSameFsPath('/tmp/sandboxed-parent/normal-ws');

            // Verify upward probes actually ran up to each boundary before stopping
            expect(lstatPaths).toContain('//server/share/subproject/.citc');
            expect(lstatPaths).toContain('/tmp/sandboxed-parent/normal-ws/.citc');
            expect(lstatPaths).toContain('/tmp/sandboxed-parent/.citc');

            // UNC walk stops before lstatting //server/share/.citc, //server/.citc, or /.citc;
            // sandbox access-denied stops upward walk before /tmp/.citc
            expect(lstatPaths).not.toContain('//server/share/.citc');
            expect(lstatPaths).not.toContain('//server/.citc');
            expect(lstatPaths).not.toContain('/.citc');
            expect(lstatPaths).not.toContain('/tmp/.citc');

            // When host platform is win32, upward .citc probing is skipped altogether
            lstatPaths.length = 0;
            findFilesSpy.mockClear();
            host.system = { ...host.system, platform: 'win32' };
            await manager.scanForRepositories();
            expect(findFilesSpy).toHaveBeenCalledTimes(2);
            expect(lstatPaths.some((p) => p.endsWith('.citc'))).toBe(false);
        } finally {
            await manager.dispose();
            registry.dispose();
        }
    });

    it('does not treat a .citc symlink as a virtualized workspace root', async () => {
        using externalCitcDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-citc-ext-'));
        using containerDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-citc-symlink-'));
        using subRepo = new ScopedTestRepo(path.join(containerDir.path, 'nested-subrepo'));
        subRepo.init();
        using _citcSymlink = new ScopedSymlink(path.join(containerDir.path, '.citc'), externalCitcDir.path, 'junction');

        const host = new FakeHostEnvironment();
        host.system = {
            ...host.system,
            platform: 'linux',
            watcher: { watch: async () => ({ unsubscribe: async () => {} }) },
        };
        host.workspace.addFolder(Uri.file(containerDir.path));

        const findFilesSpy = vi.spyOn(host.workspace, 'findFiles').mockImplementation(async () => {
            return [Uri.file(path.join(subRepo.path, '.jj', 'working_copy', 'type'))];
        });

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel();
        const manager = new JjRepositoryManager(registry, outputChannel, host);
        try {
            await manager.scanForRepositories();

            expect(findFilesSpy).toHaveBeenCalledTimes(1);
            expect(findFilesSpy.mock.calls[0]?.[1]?.fsPath).toBeSameFsPath(containerDir.path);
            expect(manager.repositories).toHaveLength(1);
            expect(manager.repositories[0].rootUri.fsPath).toBeSameFsPath(subRepo.path);
        } finally {
            await manager.dispose();
            registry.dispose();
        }
    });
});
