/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// sort-imports-ignore (needed so that we can import after `vscode` is mocked)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { resolveRepository } from '../extension';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

// Import after mock
import type { JjRepository } from '../jj-repository';
import type { JjRepositoryManager } from '../jj-repository-manager';
import type { JjScmProvider } from '../jj-scm-provider';
import { createMock } from './test-utils';

describe('resolveRepository', () => {
    let mockRepoManager: JjRepositoryManager;
    let mockScmProviders: Map<string, JjScmProvider>;
    let mockRepo: JjRepository;
    let mockScm: JjScmProvider;
    let focusedRepoVal: JjRepository | undefined;

    beforeEach(() => {
        mockRepo = createMock<JjRepository>({
            rootUri: vscode.Uri.file('/root/subrepo'),
        });
        mockScm = createMock<JjScmProvider>({});
        mockRepoManager = createMock<JjRepositoryManager>({
            getRepositoryForUri: vi.fn(),
        });
        focusedRepoVal = undefined;
        Object.defineProperty(mockRepoManager, 'focusedRepository', {
            get: () => focusedRepoVal,
            configurable: true,
        });
        mockScmProviders = new Map();
        mockScmProviders.set('/root/subrepo', mockScm);
    });

    it('resolves repository from SourceControlResourceState argument', () => {
        const mockState = { resourceUri: vscode.Uri.file('/root/subrepo/file.txt') };
        vi.mocked(mockRepoManager.getRepositoryForUri).mockReturnValue(mockRepo);

        const result = resolveRepository([mockState], mockRepoManager, mockScmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(mockRepo);
        expect(result?.scm).toBe(mockScm);
        expect(mockRepoManager.getRepositoryForUri).toHaveBeenCalledWith(mockState.resourceUri);
    });

    it('resolves repository from SourceControl object argument', () => {
        const mockSCM = { rootUri: vscode.Uri.file('/root/subrepo') };
        vi.mocked(mockRepoManager.getRepositoryForUri).mockReturnValue(mockRepo);

        const result = resolveRepository([mockSCM], mockRepoManager, mockScmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(mockRepo);
        expect(result?.scm).toBe(mockScm);
        expect(mockRepoManager.getRepositoryForUri).toHaveBeenCalledWith(mockSCM.rootUri);
    });

    it('resolves repository from active text editor when no arguments provided', () => {
        const activeUri = vscode.Uri.file('/root/subrepo/other.txt');
        // Set up vscode mock active text editor
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            get: () => ({
                document: { uri: activeUri },
            }),
            configurable: true,
        });
        vi.mocked(mockRepoManager.getRepositoryForUri).mockReturnValue(mockRepo);

        const result = resolveRepository([], mockRepoManager, mockScmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(mockRepo);
        expect(result?.scm).toBe(mockScm);
        expect(mockRepoManager.getRepositoryForUri).toHaveBeenCalledWith(activeUri);

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
            query: `changeId=abc12345&repoRoot=${encodeURIComponent('/root/subrepo')}`,
        });
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            get: () => ({
                document: { uri: commitUri },
            }),
            configurable: true,
        });
        vi.mocked(mockRepoManager.getRepositoryForUri).mockReturnValue(mockRepo);

        const result = resolveRepository([], mockRepoManager, mockScmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(mockRepo);
        expect(result?.scm).toBe(mockScm);
        expect(mockRepoManager.getRepositoryForUri).toHaveBeenCalledWith(
            expect.objectContaining({
                fsPath: '/root/subrepo',
            }),
        );

        Object.defineProperty(vscode.window, 'activeTextEditor', {
            get: () => undefined,
            configurable: true,
        });
    });

    it('falls back to focused repository when arg and active editor are not in any repository', () => {
        vi.mocked(mockRepoManager.getRepositoryForUri).mockReturnValue(undefined);
        focusedRepoVal = mockRepo;

        const result = resolveRepository([], mockRepoManager, mockScmProviders);

        expect(result).toBeDefined();
        expect(result?.repo).toBe(mockRepo);
        expect(result?.scm).toBe(mockScm);
    });

    it('returns undefined if no repository is resolved', () => {
        vi.mocked(mockRepoManager.getRepositoryForUri).mockReturnValue(undefined);
        focusedRepoVal = undefined;

        const result = resolveRepository([], mockRepoManager, mockScmProviders);

        expect(result).toBeUndefined();
    });
});
