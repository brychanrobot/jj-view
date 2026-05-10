/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    squashFilesIntoAncestorCommand,
    squashFilesIntoChildCommand,
    squashFilesIntoParentCommand,
} from '../../commands/squash-files';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { asMock, createMock } from '../test-utils';

// Mock VS Code
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showQuickPick: vi.fn(),
            showErrorMessage: vi.fn(),
        },
    });
});

describe('squash-files commands', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            outputChannel: createMock<vscode.OutputChannel>({
                appendLine: vi.fn(),
            }),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    describe('squashFilesIntoParentCommand', () => {
        test('squashes specific file to parent', async () => {
            const fileName = 'file.txt';
            await buildGraph(repo, [
                {
                    label: 'root',
                    files: { 'root.txt': 'root' },
                },
                {
                    label: 'parent',
                    parents: ['root'],
                    description: 'parent',
                    files: { [fileName]: 'parent content', 'other.txt': 'other original' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'child content', 'other.txt': 'other modified' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }];

            await squashFilesIntoParentCommand(scmProvider, jj, args);

            // Parent should have the child's version of file.txt
            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('child content');

            // but other.txt in parent should still be 'other original'
            const parentOther = repo.getFileContent('@-', 'other.txt');
            expect(parentOther).toBe('other original');

            expect(scmProvider.refresh).toHaveBeenCalled();
        });
    });

    describe('squashFilesIntoAncestorCommand', () => {
        test('squashes specific file into grandparent', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                { label: 'grandparent', description: 'grandparent', files: { [fileName]: 'grandparent content' } },
                {
                    label: 'parent',
                    parents: ['grandparent'],
                    description: 'parent',
                    files: { 'parent_file.txt': 'parent content' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'child content', 'other.txt': 'other content' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            const grandparentCommitId = ids.grandparent.commitId;

            // Mock QuickPick to return grandparent
            vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(
                createMock<vscode.QuickPickItem>({
                    detail: grandparentCommitId,
                    label: 'Ancestor 2',
                }),
            );

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }];

            await squashFilesIntoAncestorCommand(scmProvider, jj, args);

            expect(vscode.window.showQuickPick).toHaveBeenCalled();

            // Grandparent should have 'child content'
            const gpContent = repo.getFileContent(ids.grandparent.changeId, fileName);
            expect(gpContent).toBe('child content');

            // Other file should remain in child
            const childOtherContent = repo.getFileContent('@', 'other.txt');
            expect(childOtherContent).toBe('other content');

            expect(scmProvider.refresh).toHaveBeenCalled();
        });
    });

    describe('squashFilesIntoChildCommand', () => {
        test('squashes file to single child', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'parent modified' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                },
            ]);

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }, { revision: ids.parent.changeId }];

            await squashFilesIntoChildCommand(scmProvider, jj, args);

            expect(repo.getFileContent(ids.child.changeId, fileName)).toBe('parent modified');
            expect(scmProvider.refresh).toHaveBeenCalled();
        });

        test('prompts when multiple children exist', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'parent modified' },
                },
                { label: 'child1', parents: ['parent'] },
                { label: 'child2', parents: ['parent'] },
            ]);

            asMock(vscode.window.showQuickPick).mockResolvedValueOnce(ids.child2.changeId);

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }, { revision: ids.parent.changeId }];

            await squashFilesIntoChildCommand(scmProvider, jj, args);

            expect(vscode.window.showQuickPick).toHaveBeenCalled();
            expect(repo.getFileContent(ids.child2.changeId, fileName)).toBe('parent modified');
        });

        test('shows error when no children exist', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [{ label: 'only', description: 'only', files: { [fileName]: 'mod' } }]);

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }, { revision: ids.only.changeId }];

            await squashFilesIntoChildCommand(scmProvider, jj, args);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No child commits'));
        });
    });
});
