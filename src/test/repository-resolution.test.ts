/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// sort-imports-ignore (needed so that we can import after `vscode` is mocked)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from '../uri-utils';
import { resolveRepository } from '../vscode/vscode-ui-helpers';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

// Import after mock
import * as path from 'node:path';
import { CodeForgeRegistry } from '../code-forge-registry';
import type { JjRepository } from '../jj-repository';
import { JjRepositoryManager } from '../jj-repository-manager';
import type { JjScmProvider } from '../jj-scm-provider';
import { ScopedSymlink, ScopedTempDir } from './scoped-helpers';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';
import { setActiveTextEditor } from './vscode-mock';

describe('resolveRepository', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let scmProviders: Map<string, JjScmProvider>;
    let resolvedRepo: JjRepository;
    let mockScm: JjScmProvider;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, workspaceState);
        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: Uri.file(repo.path),
        });
        const registered = await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        if (!registered) {
            throw new Error('Failed to register repository');
        }
        resolvedRepo = registered;

        mockScm = createMock<JjScmProvider>({
            repo: resolvedRepo,
        });
        scmProviders = new Map();
        scmProviders.set(resolvedRepo.rootUri.fsPath, mockScm);
    });

    afterEach(async () => {
        await repoManager.dispose();
    });

    it('resolves repository from SourceControlResourceState argument', () => {
        const mockState = { resourceUri: Uri.file(path.join(repo.path, 'file.txt')) };

        const result = resolveRepository([mockState], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);
    });

    it('resolves repository from SourceControl object argument', () => {
        const mockSCM = { rootUri: Uri.file(repo.path) };

        const result = resolveRepository([mockSCM], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);
    });

    it('resolves repository from SourceControlResourceGroup argument', () => {
        const mockGroup = createMock<vscode.SourceControlResourceGroup>({
            id: 'working-copy',
            label: 'Working Copy',
            resourceStates: [],
        });
        mockScm.ownsGroup = vi.fn().mockReturnValue(true);

        const result = resolveRepository([mockGroup], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);
        expect(mockScm.ownsGroup).toHaveBeenCalledWith(mockGroup);
    });

    it('resolves repository from active text editor when no arguments provided', () => {
        const activeUri = Uri.file(path.join(repo.path, 'other.txt'));
        setActiveTextEditor(
            createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({ uri: activeUri }),
            }),
        );

        const result = resolveRepository([], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);

        setActiveTextEditor(undefined);
    });

    it('resolves repository from active custom jj-commit editor', () => {
        const commitUri = Uri.from({
            scheme: 'jj-commit',
            path: '/Commit:%20abc123',
            fragment: `changeId=abc12345&repoRoot=${encodeURIComponent(repo.path)}`,
        });
        setActiveTextEditor(
            createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({ uri: commitUri }),
            }),
        );

        const result = resolveRepository([], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);

        setActiveTextEditor(undefined);
    });

    it('falls back to focused repository when arg and active editor are not in any repository', () => {
        repoManager.setFocusedRepository(resolvedRepo);

        const result = resolveRepository([], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);
    });

    it('returns undefined if no repository is resolved', () => {
        repoManager.setFocusedRepository(undefined);

        const result = resolveRepository([], repoManager, scmProviders);

        expect(result).toBeUndefined();
    });

    it('resolves repository from SourceControlResourceState with nested symlinked directory (issue 348)', () => {
        // Test layout:
        // repo.path ($root)
        // ├── .jj/ (real directory)
        // ├── bazel-core -> targetDir (symlink to directory)
        // └── targetDir (real directory created by mkdtempSync)
        //     └── .jj -> repo.path/.jj (symlink to directory)

        // Create a target directory inside the repository
        using nestedDir = new ScopedTempDir(path.join(repo.path, 'jj-view-nested-'));
        const targetDir = nestedDir.path;

        const symlinkPath = path.join(repo.path, 'bazel-core');
        const jjSymlinkPath = path.join(targetDir, '.jj');

        // Create symlink: bazel-core -> targetDir
        using _link1 = new ScopedSymlink(symlinkPath, targetDir, 'dir');

        // Create symlink: targetDir/.jj -> repo.path/.jj
        using _link2 = new ScopedSymlink(jjSymlinkPath, path.join(repo.path, '.jj'), 'dir');

        // Resource URI is inside the symlink path
        const mockState = { resourceUri: Uri.file(path.join(symlinkPath, 'file.txt')) };

        const result = resolveRepository([mockState], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);
    });
});
