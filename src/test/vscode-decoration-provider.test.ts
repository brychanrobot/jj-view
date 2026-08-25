/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjDecorationModel } from '../jj-decoration-model';
import { JjRepositoryManager } from '../jj-repository-manager';
import { Uri } from '../uri-utils';
import { VsCodeDecorationProvider } from '../vscode/providers/vscode-decoration-provider';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('VsCodeDecorationProvider Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let provider: VsCodeDecorationProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repositoryManager = new JjRepositoryManager(registry, outputChannel, workspaceState);

        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: Uri.file(testRepo.path),
        });
        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        const model = new JjDecorationModel(repo.jj, testRepo.path);
        provider = new VsCodeDecorationProvider(model);
    });

    afterEach(async () => {
        provider.dispose();
        await repositoryManager.dispose();
    });

    test('decorates .jj files as Ignored', () => {
        const jjUri = Uri.file(`${testRepo.path}/.jj/repo`);
        const token = createMock<vscode.CancellationToken>({ isCancellationRequested: false });
        const decoration = provider.provideFileDecoration(jjUri, token);

        expect(decoration).toBeDefined();
        if (decoration && 'tooltip' in decoration) {
            expect(decoration.tooltip).toBe('Ignored');
        }
    });

    test('clears ignored cache cleanly', () => {
        expect(() => provider.clearIgnoredFileDecorationsCache()).not.toThrow();
    });
});
