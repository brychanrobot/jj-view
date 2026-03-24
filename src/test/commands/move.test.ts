/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import * as path from 'path';
import { moveToChildCommand } from '../../commands/move';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: { showQuickPick: vi.fn() },
    });
});

describe('moveToChildCommand', () => {
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

    test('moves file changes to child', async () => {
        const fileName = 'move.txt';
        // Parent (modified) -> Child
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'modified' }, isWorkingCopy: true },
            { label: 'child', parents: ['parent'], description: 'child' },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await moveToChildCommand(scmProvider, jj, args);

        const childContent = repo.getFileContent(ids['child'].changeId, fileName);
        expect(childContent).toBe('modified');
    }, 30000);

    test('moves file changes to explicit child using revision', async () => {
        const fileName = 'move2.txt';
        // Ancestor (modified) -> Child -> WorkingCopy
        const ids = await buildGraph(repo, [
            { label: 'ancestor', description: 'ancestor', files: { [fileName]: 'modified' } },
            { label: 'child', parents: ['ancestor'], description: 'child' },
            { label: 'wc', parents: ['child'], description: 'wc', isWorkingCopy: true },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri, revision: ids['ancestor'].changeId }];

        await moveToChildCommand(scmProvider, jj, args);

        const childContent = repo.getFileContent(ids['child'].changeId, fileName);
        expect(childContent).toBe('modified');
    }, 30000);

    test('prompts for child if multiple children exist', async () => {
        const fileName = 'move3.txt';
        // Ancestor (modified) -> Child1
        //                     -> Child2
        const ids = await buildGraph(repo, [
            { label: 'ancestor', description: 'ancestor', files: { [fileName]: 'modified' } },
            { label: 'child1', parents: ['ancestor'], description: 'child1' },
            { label: 'child2', parents: ['ancestor'], description: 'child2' },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri, revision: ids['ancestor'].changeId }];

        const mockShowQuickPick = vscode.window.showQuickPick as import('vitest').Mock;
        mockShowQuickPick.mockResolvedValueOnce(ids['child2'].changeId);

        await moveToChildCommand(scmProvider, jj, args);

        const child2Content = repo.getFileContent(ids['child2'].changeId, fileName);
        expect(child2Content).toBe('modified');
    }, 30000);
});
