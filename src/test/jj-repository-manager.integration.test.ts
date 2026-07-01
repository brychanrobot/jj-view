/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import type { Api } from '../extension';
import { JjRepositoryManager } from '../jj-repository-manager';
import { autoCleanup, ScopedSymlink, ScopedTempDir, ScopedTestRepo } from './scoped-helpers';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel, exposePrivate } from './test-utils';

suite('JjRepositoryManager Integration Test', () => {
    let registry: CodeForgeRegistry;
    let outputChannel: vscode.LogOutputChannel;
    let workspaceState: vscode.Memento;
    let manager: JjRepositoryManager;
    let mainRepo: TestRepo;
    let sandbox: sinon.SinonSandbox;
    let initialFolders: vscode.Uri[] = [];
    let resolvedWorkspaceRoot: string | undefined;

    suiteSetup(() => {
        process.env.VSCODE_TEST = '1';
        initialFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri);
    });

    async function setWorkspaceFoldersInternal(folders: vscode.Uri[]): Promise<void> {
        const currentFolders = vscode.workspace.workspaceFolders || [];
        const currentCount = currentFolders.length;

        if (
            currentCount === folders.length &&
            currentFolders.every((cf, i) => cf.uri.toString() === folders[i].toString())
        ) {
            return;
        }

        const newFolders = folders.map((uri, index) => ({
            uri,
            name: `folder-${index}`,
        }));

        await new Promise<void>((resolve) => {
            const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
                disposable.dispose();
                resolve();
            });

            const success = vscode.workspace.updateWorkspaceFolders(
                0,
                currentCount > 0 ? currentCount : undefined,
                ...newFolders,
            );
            if (!success) {
                disposable.dispose();
                resolve();
            }
        });
    }

    async function setWorkspaceFolders(folders: vscode.Uri[]): Promise<AsyncDisposable> {
        await setWorkspaceFoldersInternal(folders);

        return {
            async [Symbol.asyncDispose]() {
                const extension = vscode.extensions.getExtension<Api>('jj-view.jj-view');
                if (extension) {
                    const api = await extension.activate();
                    await api.repositoryManager.clear();
                }
                await manager.clear();
                await setWorkspaceFoldersInternal(initialFolders);
            },
        };
    }

    setup(async () => {
        sandbox = sinon.createSandbox();
        registry = new CodeForgeRegistry();
        outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const store = new Map<string, unknown>();
        workspaceState = createMock<vscode.Memento>({
            get: (key: string) => store.get(key),
            update: (key: string, value: unknown) => {
                store.set(key, value);
                return Promise.resolve();
            },
            keys: () => Array.from(store.keys()),
        });

        // Ensure we are working with the clean, initial workspace folder
        await setWorkspaceFoldersInternal(initialFolders);

        resolvedWorkspaceRoot = initialFolders[0] ? fs.realpathSync(initialFolders[0].fsPath) : undefined;
        if (resolvedWorkspaceRoot && fs.existsSync(resolvedWorkspaceRoot)) {
            for (const item of fs.readdirSync(resolvedWorkspaceRoot)) {
                fs.rmSync(path.join(resolvedWorkspaceRoot, item), { recursive: true, force: true });
            }
        }

        mainRepo = new TestRepo(resolvedWorkspaceRoot);
        mainRepo.init();

        sandbox.stub(vscode.window, 'visibleTextEditors').get(() => []);

        manager = new JjRepositoryManager(registry, outputChannel, workspaceState);
    });

    teardown(async () => {
        const extension = vscode.extensions.getExtension<Api>('jj-view.jj-view');
        if (extension) {
            const api = await extension.activate();
            await api.repositoryManager.clear();
        }

        await manager.dispose();
        registry.dispose();

        if (mainRepo.path !== resolvedWorkspaceRoot) {
        } else {
            try {
                if (resolvedWorkspaceRoot) {
                    for (const item of fs.readdirSync(resolvedWorkspaceRoot)) {
                        fs.rmSync(path.join(resolvedWorkspaceRoot, item), { recursive: true, force: true });
                    }
                }
            } catch {
                // Ignore
            }
        }

        await setWorkspaceFoldersInternal(initialFolders);

        sandbox.restore();
    });

    test('caching and loading repositories from workspace storage', async () => {
        // 1. Scan to discover and populate repositories
        await manager.scanForRepositories();
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);

        // Dispose the initial manager to prevent background watchers/pollers from interfering with the restart simulation
        await manager.dispose();

        // 2. Create a new manager with the same workspaceState to simulate restart
        await using restartManager = autoCleanup(new JjRepositoryManager(registry, outputChannel, workspaceState));
        // 3. Initialize from cache - should restore immediately
        await restartManager.restoreCachedRepositories();
        assert.strictEqual(restartManager.repositories.length, 1, 'Should load repo from cache');
        assert.strictEqual(restartManager.repositories[0].rootUri.fsPath, mainRepo.path);
        assert.strictEqual(restartManager.focusedRepository?.rootUri.fsPath, mainRepo.path);

        // 4. Run scan on restartManager to verify reconciliation
        await restartManager.scanForRepositories();
        assert.strictEqual(restartManager.repositories.length, 1, 'Reconciliation should keep the repository');
        assert.strictEqual(restartManager.repositories[0].rootUri.fsPath, mainRepo.path);
    });

    test('reconciliation disposes of invalid/missing cached repositories', async () => {
        // 1. Scan to discover and populate repositories
        await manager.scanForRepositories();
        assert.strictEqual(manager.repositories.length, 1);

        // Dispose the initial manager to prevent background watchers/pollers from interfering with the restart simulation
        await manager.dispose();

        // 2. Create restartManager
        await using restartManager = autoCleanup(new JjRepositoryManager(registry, outputChannel, workspaceState));
        // 3. Initialize from cache
        await restartManager.restoreCachedRepositories();
        assert.strictEqual(restartManager.repositories.length, 1);

        // 4. Delete the .jj/working_copy/type file to make the cached repo invalid/missing
        fs.rmSync(path.join(mainRepo.path, '.jj', 'working_copy', 'type'), { force: true });

        // 5. Run scan - should reconcile and dispose of the now-missing repository
        await restartManager.scanForRepositories();
        assert.strictEqual(restartManager.repositories.length, 0, 'Should remove repo that is no longer valid on disk');
    });

    test('getRepositoryForUri works for repo and subfolders', async () => {
        // Manually trigger dynamic registry
        const fileUri = vscode.Uri.file(path.join(mainRepo.path, 'sub', 'file.txt'));
        const repo = await manager.maybeRegisterRepositoryContainingUri(fileUri);
        assert.ok(repo, 'Should dynamically register repository');
        assert.strictEqual(repo.rootUri.fsPath, mainRepo.path);

        const matched = manager.getRepositoryForUri(fileUri);
        assert.ok(matched, 'Should match repo for subfolder file URI');
        assert.strictEqual(matched.rootUri.fsPath, mainRepo.path);
    });

    test('scan discovers a single repository', async () => {
        await manager.scanForRepositories();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
        assert.strictEqual(manager.focusedRepository?.rootUri.fsPath, mainRepo.path);
    });

    test('scan filters out secondary workspaces when main is present', async () => {
        const secondaryRepo = mainRepo.workspaceAdd('second_ws');
        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path), vscode.Uri.file(secondaryRepo.path)]);

        await manager.scanForRepositories();

        // Should filter out the secondary workspace and only register the main one
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
    });

    test('checkAndRegisterUri filters out secondary workspaces when main is present', async () => {
        // Register main repository first
        await manager.scanForRepositories();
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);

        // Try to dynamically register secondary workspace path
        const secondaryRepo = mainRepo.workspaceAdd('second_ws');

        const fileUri = vscode.Uri.file(path.join(secondaryRepo.path, 'file.txt'));
        const repo = await manager.maybeRegisterRepositoryContainingUri(fileUri);
        // It may return the main repository by prefix match, but the secondary workspace itself must not be registered
        assert.ok(repo === undefined || repo.rootUri.fsPath === mainRepo.path);
        assert.strictEqual(manager.repositories.length, 1);
        assert.ok(!manager.repositories.some((r) => r.rootUri.fsPath === secondaryRepo.path));
    });

    test('scan includes secondary workspace if main is NOT present', async () => {
        const secondaryRepo = mainRepo.workspaceAdd('second_ws');
        await setWorkspaceFolders([vscode.Uri.file(secondaryRepo.path)]);

        await manager.scanForRepositories();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, secondaryRepo.path);
    });

    test('getRepositoryForUri uses longest prefix match', async () => {
        const subRepoPath = path.join(mainRepo.path, 'subproject');
        fs.mkdirSync(subRepoPath, { recursive: true });
        const subRepo = new TestRepo(subRepoPath);
        subRepo.init();

        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path), vscode.Uri.file(subRepo.path)]);

        await manager.scanForRepositories();
        assert.strictEqual(manager.repositories.length, 2);

        // File in subproject should match subRepo (longest prefix match)
        const fileUri = vscode.Uri.file(path.join(subRepoPath, 'src', 'index.ts'));
        const matched = manager.getRepositoryForUri(fileUri);
        assert.ok(matched);
        assert.strictEqual(matched.rootUri.fsPath, subRepoPath);

        // File in main project but outside subproject should match mainRepo
        const mainFileUri = vscode.Uri.file(path.join(mainRepo.path, 'other.ts'));
        const mainMatched = manager.getRepositoryForUri(mainFileUri);
        assert.ok(mainMatched);
        assert.strictEqual(mainMatched.rootUri.fsPath, mainRepo.path);
    });

    test('scan discovers multiple sibling repositories in a non-repo root', async () => {
        using tmpParentDir = new ScopedTempDir(path.join(path.dirname(mainRepo.path), 'jj-view-siblings-'));
        const tmpParent = tmpParentDir.path;
        const parentPath = path.join(tmpParent, 'siblings');
        const repo1Path = path.join(parentPath, 'project1');
        const repo2Path = path.join(parentPath, 'project2');

        fs.mkdirSync(repo1Path, { recursive: true });
        fs.mkdirSync(repo2Path, { recursive: true });

        using repo1 = new ScopedTestRepo(repo1Path);
        using repo2 = new ScopedTestRepo(repo2Path);
        repo1.init();
        repo2.init();

        await using _workspace = await setWorkspaceFolders([vscode.Uri.file(parentPath)]);

        await manager.scanForRepositories();

        assert.strictEqual(manager.repositories.length, 2);
        const roots = manager.repositories.map((r) => r.rootUri.fsPath).sort();
        assert.deepStrictEqual(roots, [repo1Path, repo2Path].sort());
    });

    test('tryAutoSwitch changes focused repository', async () => {
        using otherRepo = new ScopedTestRepo();
        otherRepo.init();

        await using _workspace = await setWorkspaceFolders([
            vscode.Uri.file(mainRepo.path),
            vscode.Uri.file(otherRepo.path),
        ]);

        await manager.scanForRepositories();
        const initialFocus = manager.focusedRepository?.rootUri.fsPath;
        assert.ok(
            initialFocus === mainRepo.path || initialFocus === otherRepo.path,
            'Should focus one of the registered repositories',
        );

        const targetPath = initialFocus === mainRepo.path ? otherRepo.path : mainRepo.path;

        const fileUri = vscode.Uri.file(path.join(targetPath, 'file.ts'));
        manager.tryAutoSwitch(fileUri);

        assert.strictEqual(manager.focusedRepository?.rootUri.fsPath, targetPath);
    });

    test('getRepositoryForUri matches files through symbolic links', async () => {
        // Create a symlink to the main repository
        const symlinkPath = `${mainRepo.path}-symlink`;

        using _symlink = new ScopedSymlink(symlinkPath, mainRepo.path, 'dir');

        await manager.scanForRepositories();

        // A file URI inside the symlink path should match the repository
        const symlinkFileUri = vscode.Uri.file(path.join(symlinkPath, 'file.txt'));
        const matched = manager.getRepositoryForUri(symlinkFileUri);
        assert.ok(matched, 'Should match repository through symbolic link path');
        assert.strictEqual(matched.rootUri.fsPath, mainRepo.path);
    });

    test('getRepositoryForUri matches files in nested symlinked directory layout (issue 348)', async () => {
        // Test layout:
        // mainRepo.path ($root)
        // ├── .jj/ (real directory)
        // ├── bazel-core -> targetDir (symlink to directory)
        // └── targetDir (real directory created by mkdtempSync)
        //     └── .jj -> mainRepo.path/.jj (symlink to directory)

        // Create a target directory inside the repository
        using nestedDir = new ScopedTempDir(path.join(mainRepo.path, 'jj-view-nested-'));
        const targetDir = nestedDir.path;

        const symlinkPath = path.join(mainRepo.path, 'bazel-core');
        const jjSymlinkPath = path.join(targetDir, '.jj');

        // Create symlink: bazel-core -> targetDir
        using _link1 = new ScopedSymlink(symlinkPath, targetDir, 'dir');

        // Create symlink: targetDir/.jj -> mainRepo.path/.jj
        using _link2 = new ScopedSymlink(jjSymlinkPath, path.join(mainRepo.path, '.jj'), 'dir');

        // Scan to discover repositories
        await manager.scanForRepositories();

        // Verify that we only have the main repository registered, not the nested one
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);

        // A file URI inside the symlink path should match the repository
        const symlinkFileUri = vscode.Uri.file(path.join(symlinkPath, 'file.txt'));
        const matched = manager.getRepositoryForUri(symlinkFileUri);
        assert.ok(matched, 'Should match repository through nested symlink path');
        assert.strictEqual(matched.rootUri.fsPath, mainRepo.path);
    });

    test('scan ignores repositories listed in ignoredRepositories config', async () => {
        using otherRepo = new ScopedTestRepo();
        otherRepo.init();

        await using _workspace = await setWorkspaceFolders([
            vscode.Uri.file(mainRepo.path),
            vscode.Uri.file(otherRepo.path),
        ]);

        // Stub configuration
        const getStub = sandbox.stub();
        getStub.withArgs('autoRepositoryDetection', true).returns(true);
        getStub.withArgs('scanRepositories', []).returns([]);
        getStub.withArgs('ignoredRepositories', []).returns([otherRepo.path]);

        sandbox.stub(vscode.workspace, 'getConfiguration').returns(
            createMock<vscode.WorkspaceConfiguration>({
                get: (section: string, defaultValue?: unknown) => getStub(section, defaultValue),
                has: () => true,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            }),
        );

        await manager.scanForRepositories();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
    });

    test('scan registers repositories in scanRepositories config even if autoDetect is false', async () => {
        const otherRepoPath = path.join(mainRepo.path, 'other-project');
        using otherRepo = new ScopedTestRepo(otherRepoPath);
        otherRepo.init();

        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path)]);

        // Stub configuration: autoDetect is false, but otherRepo is in scanRepositories
        const getStub = sandbox.stub();
        getStub.withArgs('autoRepositoryDetection', true).returns(false);
        getStub.withArgs('scanRepositories', []).returns([otherRepo.path]);
        getStub.withArgs('ignoredRepositories', []).returns([]);

        sandbox.stub(vscode.workspace, 'getConfiguration').returns(
            createMock<vscode.WorkspaceConfiguration>({
                get: (section: string, defaultValue?: unknown) => getStub(section, defaultValue),
                has: () => true,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            }),
        );

        await manager.scanForRepositories();

        // Should discover both main (due to autoDetect=false on workspace folders) and otherRepo (due to scanRepositories)
        assert.strictEqual(manager.repositories.length, 2);
        const roots = manager.repositories.map((r) => r.rootUri.fsPath).sort();
        assert.deepStrictEqual(roots, [mainRepo.path, otherRepo.path].sort());
    });

    test('scan registers parent repository if workspace root is a child directory', async () => {
        const subfolder = path.join(mainRepo.path, 'src');
        fs.mkdirSync(subfolder, { recursive: true });

        await setWorkspaceFolders([vscode.Uri.file(subfolder)]);

        await manager.scanForRepositories();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
    });

    test('checkAndRegisterUri works when directory path is passed', async () => {
        const subfolder = path.join(mainRepo.path, 'src');
        fs.mkdirSync(subfolder, { recursive: true });

        const registered = await manager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(subfolder));
        assert.ok(registered);
        assert.strictEqual(registered.rootUri.fsPath, mainRepo.path);
    });

    test('scan recursively discovers sub-repositories inside workspace folders using real findFiles', async () => {
        // Create subprojects nested at different levels
        const sub1 = path.join(mainRepo.path, 'subproject1');
        const sub2 = path.join(mainRepo.path, 'nested', 'subproject2');

        using sub1Repo = new ScopedTestRepo(sub1);
        sub1Repo.init();

        using sub2Repo = new ScopedTestRepo(sub2);
        sub2Repo.init();

        await manager.scanForRepositories();

        const roots = manager.repositories.map((r) => r.rootUri.fsPath);

        // Should discover:
        // 1. mainRepo (via findRepoRoot check of the workspace folder root itself)
        // 2. subproject1 (via auto-detection scan of subfolders)
        // 3. subproject2 (via recursive auto-detection scan of subfolders)
        assert.ok(roots.includes(mainRepo.path), 'Should discover mainRepo');
        assert.ok(roots.includes(sub1), 'Should discover sub1');
        assert.ok(roots.includes(sub2), 'Should discover sub2');
    });

    test('scan discovers immediate sub-repositories only when autoRepositoryDetection=subFolders using real findFiles', async () => {
        // Create subprojects nested at different levels
        const sub1 = path.join(mainRepo.path, 'subproject1');
        const sub2 = path.join(mainRepo.path, 'nested', 'subproject2');

        using sub1Repo = new ScopedTestRepo(sub1);
        sub1Repo.init();

        using sub2Repo = new ScopedTestRepo(sub2);
        sub2Repo.init();

        const getStub = sandbox.stub();
        getStub.withArgs('autoRepositoryDetection', true).returns('subFolders');
        getStub.withArgs('scanRepositories', []).returns([]);
        getStub.withArgs('ignoredRepositories', []).returns([]);

        sandbox.stub(vscode.workspace, 'getConfiguration').returns(
            createMock<vscode.WorkspaceConfiguration>({
                get: (section: string, defaultValue?: unknown) => getStub(section, defaultValue),
                has: () => true,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            }),
        );

        await manager.scanForRepositories();

        const roots = manager.repositories.map((r) => r.rootUri.fsPath);

        // Should discover:
        // 1. mainRepo (via findRepoRoot check of the workspace folder root itself)
        // 2. subproject1 (immediate subfolder)
        // but should NOT discover subproject2 (since it's nested two levels deep)
        assert.ok(roots.includes(mainRepo.path), 'Should discover mainRepo');
        assert.ok(roots.includes(sub1), 'Should discover sub1');
        assert.ok(!roots.includes(sub2), 'Should NOT discover sub2');
    });

    test('maybeRegisterRepositoryContainingUri resolves concurrent calls for the same path to the same repository', async () => {
        const subfolder = path.join(mainRepo.path, 'src');
        fs.mkdirSync(subfolder, { recursive: true });

        const [repo1, repo2] = await Promise.all([
            manager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(subfolder)),
            manager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(subfolder)),
        ]);

        assert.ok(repo1);
        assert.ok(repo2);
        assert.strictEqual(
            repo1,
            repo2,
            'Concurrent registrations for same path must resolve to same repository instance',
        );
        assert.strictEqual(manager.repositories.length, 1);
    });

    test('maybeRegisterRepositoryContainingUri resolves concurrent calls for different paths under the same repository', async () => {
        const subfolder1 = path.join(mainRepo.path, 'src');
        const subfolder2 = path.join(mainRepo.path, 'test');
        fs.mkdirSync(subfolder1, { recursive: true });
        fs.mkdirSync(subfolder2, { recursive: true });

        const [repo1, repo2] = await Promise.all([
            manager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(subfolder1)),
            manager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(subfolder2)),
        ]);

        assert.ok(repo1);
        assert.ok(repo2);
        assert.strictEqual(
            repo1,
            repo2,
            'Concurrent registrations for different paths in same repo must resolve to same repository instance',
        );
        assert.strictEqual(manager.repositories.length, 1);
    });

    test('isPathInOrAncestorOfWorkspace rejects repositories in unrelated directories', async () => {
        using tempParentDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-unrelated-'));
        const tempParent = tempParentDir.path;

        using unrelatedRepo = new ScopedTestRepo(tempParent);
        unrelatedRepo.init();

        const registered = await manager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(unrelatedRepo.path));
        assert.strictEqual(
            registered,
            undefined,
            'Should reject repository in unrelated directory outside workspace folders',
        );
    });

    test('maybeRegisterRepositoryContainingUri registers parent repository if workspace root is a child directory', async () => {
        const subfolder = path.join(mainRepo.path, 'src');
        fs.mkdirSync(subfolder, { recursive: true });

        await setWorkspaceFolders([vscode.Uri.file(subfolder)]);

        // Try dynamically registering a file inside the subfolder, which is part of the parent repository
        const fileUri = vscode.Uri.file(path.join(subfolder, 'file.txt'));
        const registered = await manager.maybeRegisterRepositoryContainingUri(fileUri);

        assert.ok(registered, 'Should register parent repository');
        assert.strictEqual(registered.rootUri.fsPath, mainRepo.path);
    });

    test('concurrent scanForRepositories calls run at most twice (one active, one queued)', async () => {
        const managerPriv = exposePrivate<{ doScan(): Promise<void> }>(manager);
        const doScanSpy = sandbox.spy(managerPriv, 'doScan');
        const scan1 = manager.scanForRepositories();
        const scan2 = manager.scanForRepositories();
        const scan3 = manager.scanForRepositories();
        await Promise.all([scan1, scan2, scan3]);

        assert.ok(
            doScanSpy.callCount <= 2,
            `doScan should be called at most twice, called ${doScanSpy.callCount} times`,
        );
        assert.strictEqual(manager.repositories.length, 1);
    });

    test('clear() disposes of all repositories, and subsequent scan re-discovers them', async () => {
        await manager.scanForRepositories();
        assert.strictEqual(manager.repositories.length, 1);
        const repoInstance = manager.repositories[0];

        const closeSpy = sandbox.spy();
        const disposable = manager.onDidCloseRepository(closeSpy);

        await manager.clear();
        disposable.dispose();

        assert.strictEqual(manager.repositories.length, 0);
        assert.strictEqual(manager.focusedRepository, undefined);
        assert.ok(closeSpy.calledWith(repoInstance));

        // Subsequent scan can cleanly re-discover it
        await manager.scanForRepositories();
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
    });
});
