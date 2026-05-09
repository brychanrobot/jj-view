/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { squashFileToChildCommand } from '../../commands/squash-file-to-child';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: { showQuickPick: vi.fn(), showErrorMessage: vi.fn() },
    });
});

describe('squashFileToChildCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({ refresh: vi.fn() });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('squashes file changes to child', async () => {
        const fileName = 'squash.txt';
        // Parent (modified) -> Child
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'modified' }, isCurrentWorkingCopy: true },
            { label: 'child', parents: ['parent'], description: 'child' },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await squashFileToChildCommand(scmProvider, jj, args);

        const childContent = repo.getFileContent(ids.child.changeId, fileName);
        expect(childContent).toBe('modified');
        expect(scmProvider.refresh).toHaveBeenCalled();
    }, 30000);

    test('squashes file changes to explicit child using revision', async () => {
        const fileName = 'squash2.txt';
        // Ancestor (modified) -> Child -> WorkingCopy
        const ids = await buildGraph(repo, [
            { label: 'ancestor', description: 'ancestor', files: { [fileName]: 'modified' } },
            { label: 'child', parents: ['ancestor'], description: 'child' },
            { label: 'wc', parents: ['child'], description: 'wc', isCurrentWorkingCopy: true },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri, revision: ids.ancestor.changeId }];

        await squashFileToChildCommand(scmProvider, jj, args);

        const childContent = repo.getFileContent(ids.child.changeId, fileName);
        expect(childContent).toBe('modified');
    }, 30000);

    test('prompts for child if multiple children exist', async () => {
        const fileName = 'squash3.txt';
        // Ancestor (modified) -> Child1
        //                     -> Child2
        const ids = await buildGraph(repo, [
            { label: 'ancestor', description: 'ancestor', files: { [fileName]: 'modified' } },
            { label: 'child1', parents: ['ancestor'], description: 'child1' },
            { label: 'child2', parents: ['ancestor'], description: 'child2' },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri, revision: ids.ancestor.changeId }];

        const mockShowQuickPick = vscode.window.showQuickPick as import('vitest').Mock;
        mockShowQuickPick.mockResolvedValueOnce(ids.child2.changeId);

        await squashFileToChildCommand(scmProvider, jj, args);

        const child2Content = repo.getFileContent(ids.child2.changeId, fileName);
        expect(child2Content).toBe('modified');
    }, 30000);

    test('shows error message if no children exist', async () => {
        const fileName = 'no-children.txt';
        repo.writeFile(fileName, 'content');
        repo.describe('no children');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await squashFileToChildCommand(scmProvider, jj, args);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No child commits'));
    }, 30000);
});
