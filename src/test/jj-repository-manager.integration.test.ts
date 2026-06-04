/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjRepositoryManager } from '../jj-repository-manager';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

suite('JjRepositoryManager Integration Test', () => {
    let registry: CodeForgeRegistry;
    let outputChannel: vscode.OutputChannel;
    let workspaceState: vscode.Memento;
    let manager: JjRepositoryManager;
    let mainRepo: TestRepo;
    let sandbox: sinon.SinonSandbox;
    let initialFolders: vscode.Uri[] = [];
    let resolvedWorkspaceRoot: string | undefined;
    let extraRepos: TestRepo[] = [];
    let extraDirs: string[] = [];

    suiteSetup(() => {
        initialFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri);
    });

    async function setWorkspaceFolders(folders: vscode.Uri[]): Promise<void> {
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

    setup(async () => {
        extraRepos = [];
        extraDirs = [];
        sandbox = sinon.createSandbox();
        registry = new CodeForgeRegistry();
        outputChannel = createMock<vscode.OutputChannel>({
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
        await setWorkspaceFolders(initialFolders);

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
        await manager.dispose();
        registry.dispose();

        for (const repo of extraRepos) {
            repo.dispose();
        }
        for (const dir of extraDirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // Ignore
            }
        }

        if (mainRepo.path !== resolvedWorkspaceRoot) {
            mainRepo.dispose();
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

        await setWorkspaceFolders(initialFolders);

        sandbox.restore();
    });

    test('caching and loading repositories from workspace storage', async () => {
        // 1. Scan to discover and populate repositories
        await manager.scan();
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);

        // 2. Create a new manager with the same workspaceState to simulate restart
        const restartManager = new JjRepositoryManager(registry, outputChannel, workspaceState);
        try {
            // 3. Initialize from cache - should restore immediately
            await restartManager.initializeFromCache();
            assert.strictEqual(restartManager.repositories.length, 1, 'Should load repo from cache');
            assert.strictEqual(restartManager.repositories[0].rootUri.fsPath, mainRepo.path);
            assert.strictEqual(restartManager.focusedRepository?.rootUri.fsPath, mainRepo.path);

            // 4. Run scan on restartManager to verify reconciliation
            await restartManager.scan();
            assert.strictEqual(restartManager.repositories.length, 1, 'Reconciliation should keep the repository');
            assert.strictEqual(restartManager.repositories[0].rootUri.fsPath, mainRepo.path);
        } finally {
            await restartManager.dispose();
        }
    });

    test('reconciliation disposes of invalid/missing cached repositories', async () => {
        // 1. Scan to discover and populate repositories
        await manager.scan();
        assert.strictEqual(manager.repositories.length, 1);

        // 2. Create restartManager
        const restartManager = new JjRepositoryManager(registry, outputChannel, workspaceState);
        try {
            // 3. Initialize from cache
            await restartManager.initializeFromCache();
            assert.strictEqual(restartManager.repositories.length, 1);

            // 4. Delete the .jj/working_copy/type file to make the cached repo invalid/missing
            fs.rmSync(path.join(mainRepo.path, '.jj', 'working_copy', 'type'), { force: true });

            // 5. Run scan - should reconcile and dispose of the now-missing repository
            await restartManager.scan();
            assert.strictEqual(
                restartManager.repositories.length,
                0,
                'Should remove repo that is no longer valid on disk',
            );
        } finally {
            await restartManager.dispose();
        }
    });

    test('scan preserves valid cached repositories even if not in workspace folders', async () => {
        // 1. Scan to discover and populate repositories
        await manager.scan();
        assert.strictEqual(manager.repositories.length, 1);

        // 2. Create restartManager
        const restartManager = new JjRepositoryManager(registry, outputChannel, workspaceState);
        try {
            // 3. Initialize from cache
            await restartManager.initializeFromCache();
            assert.strictEqual(restartManager.repositories.length, 1);

            // 4. Change workspace folders to something empty
            const emptyParent = fs.realpathSync(
                fs.mkdtempSync(path.join(path.dirname(mainRepo.path), 'jj-view-empty-')),
            );
            try {
                await setWorkspaceFolders([vscode.Uri.file(emptyParent)]);

                // 5. Run scan - should preserve the valid cached repository since it exists on disk
                await restartManager.scan();
                assert.strictEqual(
                    restartManager.repositories.length,
                    1,
                    'Should preserve valid repo outside workspace',
                );
                assert.strictEqual(restartManager.repositories[0].rootUri.fsPath, mainRepo.path);
            } finally {
                fs.rmSync(emptyParent, { recursive: true, force: true });
            }
        } finally {
            await restartManager.dispose();
        }
    });

    test('getRepositoryForUri works for repo and subfolders', async () => {
        // Manually trigger dynamic registry
        const fileUri = vscode.Uri.file(path.join(mainRepo.path, 'sub', 'file.txt'));
        const repo = await manager.checkAndRegisterUri(fileUri);
        assert.ok(repo, 'Should dynamically register repository');
        assert.strictEqual(repo.rootUri.fsPath, mainRepo.path);

        const matched = manager.getRepositoryForUri(fileUri);
        assert.ok(matched, 'Should match repo for subfolder file URI');
        assert.strictEqual(matched.rootUri.fsPath, mainRepo.path);
    });

    test('scan discovers a single repository', async () => {
        await manager.scan();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
        assert.strictEqual(manager.focusedRepository?.rootUri.fsPath, mainRepo.path);
    });

    test('scan filters out secondary workspaces when main is present', async () => {
        const secondaryRepo = mainRepo.workspaceAdd('second_ws');
        extraRepos.push(secondaryRepo);
        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path), vscode.Uri.file(secondaryRepo.path)]);

        await manager.scan();

        // Should filter out the secondary workspace and only register the main one
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
    });

    test('checkAndRegisterUri filters out secondary workspaces when main is present', async () => {
        // Register main repository first
        await manager.scan();
        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);

        // Try to dynamically register secondary workspace path
        const secondaryRepo = mainRepo.workspaceAdd('second_ws');
        extraRepos.push(secondaryRepo);

        const fileUri = vscode.Uri.file(path.join(secondaryRepo.path, 'file.txt'));
        const repo = await manager.checkAndRegisterUri(fileUri);
        // It may return the main repository by prefix match, but the secondary workspace itself must not be registered
        assert.ok(repo === undefined || repo.rootUri.fsPath === mainRepo.path);
        assert.strictEqual(manager.repositories.length, 1);
        assert.ok(!manager.repositories.some((r) => r.rootUri.fsPath === secondaryRepo.path));
    });

    test('scan includes secondary workspace if main is NOT present', async () => {
        const secondaryRepo = mainRepo.workspaceAdd('second_ws');
        extraRepos.push(secondaryRepo);
        await setWorkspaceFolders([vscode.Uri.file(secondaryRepo.path)]);

        await manager.scan();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, secondaryRepo.path);
    });

    test('getRepositoryForUri uses longest prefix match', async () => {
        const subRepoPath = path.join(mainRepo.path, 'subproject');
        fs.mkdirSync(subRepoPath, { recursive: true });
        const subRepo = new TestRepo(subRepoPath);
        extraRepos.push(subRepo);
        subRepo.init();

        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path), vscode.Uri.file(subRepo.path)]);

        await manager.scan();
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
        // Create a non-repo parent directory outside mainRepo
        const tmpParent = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(mainRepo.path), 'jj-view-siblings-')));
        extraDirs.push(tmpParent);
        const parentPath = path.join(tmpParent, 'siblings');
        const repo1Path = path.join(parentPath, 'project1');
        const repo2Path = path.join(parentPath, 'project2');

        fs.mkdirSync(repo1Path, { recursive: true });
        fs.mkdirSync(repo2Path, { recursive: true });

        const repo1 = new TestRepo(repo1Path);
        const repo2 = new TestRepo(repo2Path);
        extraRepos.push(repo1, repo2);
        repo1.init();
        repo2.init();

        await setWorkspaceFolders([vscode.Uri.file(parentPath)]);

        await manager.scan();

        assert.strictEqual(manager.repositories.length, 2);
        const roots = manager.repositories.map((r) => r.rootUri.fsPath).sort();
        assert.deepStrictEqual(roots, [repo1Path, repo2Path].sort());
    });

    test('tryAutoSwitch changes focused repository', async () => {
        const otherRepo = new TestRepo();
        extraRepos.push(otherRepo);
        otherRepo.init();

        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path), vscode.Uri.file(otherRepo.path)]);

        await manager.scan();
        assert.strictEqual(manager.focusedRepository?.rootUri.fsPath, mainRepo.path);

        const fileUri = vscode.Uri.file(path.join(otherRepo.path, 'file.ts'));
        manager.tryAutoSwitch(fileUri);

        assert.strictEqual(manager.focusedRepository?.rootUri.fsPath, otherRepo.path);
    });

    test('getRepositoryForUri matches files through symbolic links', async () => {
        // Create a symlink to the main repository
        const symlinkPath = `${mainRepo.path}-symlink`;

        try {
            fs.symlinkSync(mainRepo.path, symlinkPath, 'dir');

            await manager.scan();

            // A file URI inside the symlink path should match the repository
            const symlinkFileUri = vscode.Uri.file(path.join(symlinkPath, 'file.txt'));
            const matched = manager.getRepositoryForUri(symlinkFileUri);
            assert.ok(matched, 'Should match repository through symbolic link path');
            assert.strictEqual(matched.rootUri.fsPath, mainRepo.path);
        } finally {
            try {
                fs.unlinkSync(symlinkPath);
            } catch {
                // Ignore
            }
        }
    });

    test('scan ignores repositories listed in ignoredRepositories config', async () => {
        const otherRepo = new TestRepo();
        extraRepos.push(otherRepo);
        otherRepo.init();

        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path), vscode.Uri.file(otherRepo.path)]);

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

        await manager.scan();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
    });

    test('scan registers repositories in scanRepositories config even if autoDetect is false', async () => {
        const otherRepo = new TestRepo();
        extraRepos.push(otherRepo);
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

        await manager.scan();

        // Should discover both main (due to autoDetect=false on workspace folders) and otherRepo (due to scanRepositories)
        assert.strictEqual(manager.repositories.length, 2);
        const roots = manager.repositories.map((r) => r.rootUri.fsPath).sort();
        assert.deepStrictEqual(roots, [mainRepo.path, otherRepo.path].sort());
    });

    test('scan keeps repositories of visible text editors even if not in workspace folders', async () => {
        const otherRepo = new TestRepo();
        extraRepos.push(otherRepo);
        otherRepo.init();

        await setWorkspaceFolders([vscode.Uri.file(mainRepo.path)]);

        // Stub visibleTextEditors to contain a file from otherRepo
        sandbox.stub(vscode.window, 'visibleTextEditors').get(() => [
            createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({
                    uri: vscode.Uri.file(path.join(otherRepo.path, 'somefile.txt')),
                }),
            }),
        ]);

        // First scan discovers mainRepo and registers it
        await manager.scan();

        // Register otherRepo dynamically
        await manager.checkAndRegisterUri(vscode.Uri.file(path.join(otherRepo.path, 'somefile.txt')));

        assert.strictEqual(manager.repositories.length, 2);

        // Scan again (like configuration changes or startup scan finishing)
        await manager.scan();

        // Should still keep both repositories because otherRepo is open in a visible text editor!
        assert.strictEqual(manager.repositories.length, 2);
        const roots = manager.repositories.map((r) => r.rootUri.fsPath).sort();
        assert.deepStrictEqual(roots, [mainRepo.path, otherRepo.path].sort());
    });

    test('scan discovers parent repository if workspace root is a child directory', async () => {
        const subfolder = path.join(mainRepo.path, 'src');
        fs.mkdirSync(subfolder, { recursive: true });

        await setWorkspaceFolders([vscode.Uri.file(subfolder)]);

        await manager.scan();

        assert.strictEqual(manager.repositories.length, 1);
        assert.strictEqual(manager.repositories[0].rootUri.fsPath, mainRepo.path);
    });

    test('checkAndRegisterUri works when directory path is passed', async () => {
        const subfolder = path.join(mainRepo.path, 'src');
        fs.mkdirSync(subfolder, { recursive: true });

        const registered = await manager.checkAndRegisterUri(vscode.Uri.file(subfolder));
        assert.ok(registered);
        assert.strictEqual(registered.rootUri.fsPath, mainRepo.path);
    });

    test('scan recursively discovers sub-repositories inside workspace folders using real findFiles', async () => {
        // Create subprojects nested at different levels
        const sub1 = path.join(mainRepo.path, 'subproject1');
        const sub2 = path.join(mainRepo.path, 'nested', 'subproject2');

        fs.mkdirSync(path.join(sub1, '.jj', 'working_copy'), { recursive: true });
        fs.writeFileSync(path.join(sub1, '.jj', 'working_copy', 'type'), 'git');
        fs.mkdirSync(path.join(sub1, '.jj', 'repo'), { recursive: true });

        fs.mkdirSync(path.join(sub2, '.jj', 'working_copy'), { recursive: true });
        fs.writeFileSync(path.join(sub2, '.jj', 'working_copy', 'type'), 'git');
        fs.mkdirSync(path.join(sub2, '.jj', 'repo'), { recursive: true });

        await manager.scan();

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

        fs.mkdirSync(path.join(sub1, '.jj', 'working_copy'), { recursive: true });
        fs.writeFileSync(path.join(sub1, '.jj', 'working_copy', 'type'), 'git');
        fs.mkdirSync(path.join(sub1, '.jj', 'repo'), { recursive: true });

        fs.mkdirSync(path.join(sub2, '.jj', 'working_copy'), { recursive: true });
        fs.writeFileSync(path.join(sub2, '.jj', 'working_copy', 'type'), 'git');
        fs.mkdirSync(path.join(sub2, '.jj', 'repo'), { recursive: true });

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

        await manager.scan();

        const roots = manager.repositories.map((r) => r.rootUri.fsPath);

        // Should discover:
        // 1. mainRepo (via findRepoRoot check of the workspace folder root itself)
        // 2. subproject1 (immediate subfolder)
        // but should NOT discover subproject2 (since it's nested two levels deep)
        assert.ok(roots.includes(mainRepo.path), 'Should discover mainRepo');
        assert.ok(roots.includes(sub1), 'Should discover sub1');
        assert.ok(!roots.includes(sub2), 'Should NOT discover sub2');
    });
});
