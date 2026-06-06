/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// sort-imports-ignore (needed so that we can import after `vscode` is mocked)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resolveRepository } from '../commands/command-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

// Import after mock
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeForgeRegistry } from '../code-forge-registry';
import type { JjRepository } from '../jj-repository';
import { JjRepositoryManager } from '../jj-repository-manager';
import type { JjScmProvider } from '../jj-scm-provider';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

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
        const outputChannel = createMock<vscode.OutputChannel>({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, workspaceState);
        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: vscode.Uri.file(repo.path),
        });
        const registered = await repoManager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(repo.path));
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
        repo.dispose();
    });

    it('resolves repository from SourceControlResourceState argument', () => {
        const mockState = { resourceUri: vscode.Uri.file(path.join(repo.path, 'file.txt')) };

        const result = resolveRepository([mockState], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);
    });

    it('resolves repository from SourceControl object argument', () => {
        const mockSCM = { rootUri: vscode.Uri.file(repo.path) };

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
        const activeUri = vscode.Uri.file(path.join(repo.path, 'other.txt'));
        // Set up vscode mock active text editor
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            get: () => ({
                document: { uri: activeUri },
            }),
            configurable: true,
        });

        const result = resolveRepository([], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);

        // Reset active text editor
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            get: () => undefined,
            configurable: true,
        });
    });

    it('resolves repository from active custom jj-commit editor', () => {
        const commitUri = vscode.Uri.from({
            scheme: 'jj-commit',
            path: '/Commit:%20abc123',
            query: `changeId=abc12345&repoRoot=${encodeURIComponent(repo.path)}`,
        });
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            get: () => ({
                document: { uri: commitUri },
            }),
            configurable: true,
        });

        const result = resolveRepository([], repoManager, scmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(resolvedRepo);
        expect(result?.scm).toBe(mockScm);

        Object.defineProperty(vscode.window, 'activeTextEditor', {
            get: () => undefined,
            configurable: true,
        });
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
        const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(repo.path, 'jj-view-nested-')));
        const symlinkPath = path.join(repo.path, 'bazel-core');
        const jjSymlinkPath = path.join(targetDir, '.jj');

        try {
            // Create symlink: bazel-core -> targetDir
            fs.symlinkSync(targetDir, symlinkPath, 'dir');

            // Create symlink: targetDir/.jj -> repo.path/.jj
            fs.symlinkSync(path.join(repo.path, '.jj'), jjSymlinkPath, 'dir');

            // Resource URI is inside the symlink path
            const mockState = { resourceUri: vscode.Uri.file(path.join(symlinkPath, 'file.txt')) };

            const result = resolveRepository([mockState], repoManager, scmProviders);

            expect(result).toBeDefined();
            expect(result?.repo).toBe(resolvedRepo);
            expect(result?.scm).toBe(mockScm);
        } finally {
            try {
                fs.unlinkSync(symlinkPath);
            } catch {}
            try {
                fs.unlinkSync(jjSymlinkPath);
            } catch {}
            try {
                fs.rmdirSync(targetDir);
            } catch {}
        }
    });
});
