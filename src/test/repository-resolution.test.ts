/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { resolveRepository } from '../common/ui-helpers';
import type { JjRepository } from '../jj-repository';
import { JjRepositoryManager } from '../jj-repository-manager';
import { Uri } from '../uri-utils';
import { ScopedSymlink, ScopedTempDir } from './scoped-helpers';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

describe('resolveRepository', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let resolvedRepo: JjRepository;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        vscode.workspace.updateWorkspaceFolders(0, null, { uri: Uri.file(repo.path) });

        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, workspaceState);
        const registered = await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        if (!registered) {
            throw new Error('Failed to register repository');
        }
        resolvedRepo = registered;
    });

    afterEach(async () => {
        await repoManager.dispose();
    });

    it('resolves repository from SourceControlResourceState argument', () => {
        const mockState = { resourceUri: Uri.file(path.join(repo.path, 'file.txt')) };

        const result = resolveRepository(repoManager, { args: [mockState] });

        expect(result).toBe(resolvedRepo);
    });

    it('resolves repository from SourceControl object argument', () => {
        const mockSCM = { rootUri: Uri.file(repo.path) };

        const result = resolveRepository(repoManager, { args: [mockSCM] });

        expect(result).toBe(resolvedRepo);
    });

    it('resolves repository from active text editor when no arguments provided', () => {
        const activeUri = Uri.file(path.join(repo.path, 'other.txt'));

        const result = resolveRepository(repoManager, { activeUri });

        expect(result).toBe(resolvedRepo);
    });

    it('resolves repository from active custom jj-commit editor', () => {
        const commitUri = Uri.from({
            scheme: 'jj-commit',
            path: '/Commit:%20abc123',
            fragment: `changeId=abc12345&repoRoot=${encodeURIComponent(repo.path)}`,
        });

        const result = resolveRepository(repoManager, { activeUri: commitUri });

        expect(result).toBe(resolvedRepo);
    });

    it('falls back to focused repository when arg and active editor are not in any repository', () => {
        repoManager.setFocusedRepository(resolvedRepo);

        const result = resolveRepository(repoManager);

        expect(result).toBe(resolvedRepo);
    });

    it('returns undefined if no repository is resolved', () => {
        repoManager.setFocusedRepository(undefined);

        const result = resolveRepository(repoManager);

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

        const result = resolveRepository(repoManager, { args: [mockState] });

        expect(result).toBe(resolvedRepo);
    });
});
