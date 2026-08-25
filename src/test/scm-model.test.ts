/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { CodeForgeRegistry } from '../code-forge-registry';
import { JjRepositoryManager } from '../jj-repository-manager';
import { ScmModel, type ScmSnapshot } from '../scm-model';
import { Uri } from '../uri-utils';
import { buildGraph, TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('ScmModel Domain Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let scmModel: ScmModel;

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

        scmModel = new ScmModel(repo, outputChannel);
    });

    afterEach(async () => {
        scmModel.dispose();
        await repositoryManager.dispose();
    });

    test('computes working copy changes and fires onDidChangeSnapshot', async () => {
        const snapshots: ScmSnapshot[] = [];
        scmModel.onDidChangeSnapshot((s) => {
            snapshots.push(s);
        });

        testRepo.writeFile('test.txt', 'hello world\n');
        await scmModel.updateSnapshot({ reason: 'test write' });

        expect(snapshots.length).toBeGreaterThan(0);
        const lastSnapshot = snapshots[snapshots.length - 1];
        expect(lastSnapshot.workingCopyChanges.length).toBeGreaterThanOrEqual(1);
        expect(lastSnapshot.workingCopyChanges.some((c) => c.path.includes('test.txt'))).toBe(true);
        expect(lastSnapshot.workingCopyCount).toBeGreaterThanOrEqual(1);
    });

    test('detects mutable ancestors and builds ancestor entries', async () => {
        await buildGraph(testRepo, [
            { label: 'c1', description: 'first ancestor commit' },
            { label: 'c2', parents: ['c1'], description: 'second ancestor commit' },
            { label: 'c3', parents: ['c2'], description: 'working copy' },
        ]);

        await scmModel.updateSnapshot({ reason: 'graph created' });

        const snapshot = scmModel.snapshot;
        expect(snapshot).toBeDefined();
        expect(snapshot?.ancestors.length).toBeGreaterThanOrEqual(2);
        expect(snapshot?.ancestors[0].prefix).toBe('@-1');
        expect(snapshot?.ancestors[0].isMutable).toBe(true);
        expect(snapshot?.parentMutable).toBe(true);
    });

    test('tracks selected commit IDs and updates description', async () => {
        scmModel.handleSelectionChange(['commit-1', 'commit-2']);
        expect(scmModel.getSelectedCommitIds()).toEqual(['commit-1', 'commit-2']);

        await scmModel.setDescription('New working copy message');
        const log = await scmModel.jj.getLog({ revision: '@' });
        expect(log[0]?.description?.trim()).toBe('New working copy message');
    });

    test('disposes safely and unsubscribes all listeners', () => {
        expect(() => {
            scmModel.dispose();
            scmModel.dispose();
        }).not.toThrow();
    });
});
