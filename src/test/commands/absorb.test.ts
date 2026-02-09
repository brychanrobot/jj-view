/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import * as vscode from 'vscode';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { absorbCommand } from '../../commands/absorb';
import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { TestRepo, buildGraph } from '../test-repo';
import { createMock } from '../test-utils';

// Mock vscode
vi.mock('vscode', () => {
    return {
        ProgressLocation: { Notification: 15 },
        window: {
            showErrorMessage: vi.fn(),
            withProgress: vi.fn((_options, task) => task()),
            setStatusBarMessage: vi.fn(),
        },
        Uri: {
            file: (path: string) => ({ fsPath: path }),
        },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/root' } }],
        },
    };
});

describe('absorbCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    it('should absorb working copy changes', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'line1\nline2\n' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { [fileName]: 'line1\nline2 modified\n' },
                isWorkingCopy: true,
            },
        ]);

        await absorbCommand(scmProvider, jj, []);

        // Verify parent has the change
        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('line1\nline2 modified\n');
        
        expect(scmProvider.refresh).toHaveBeenCalled();
        expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith('Absorb completed.', 3000);
    }, 20000);

    it('should absorb from specific revision', async () => {
        const fileName = 'rev-absorb.txt';
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { [fileName]: 'base\n' } },
            {
                label: 'A',
                parents: ['root'],
                description: 'A',
                files: { [fileName]: 'base\nlineA\n' },
            },
            {
                label: 'B',
                parents: ['A'],
                description: 'B',
                files: { [fileName]: 'base\nlineA modified\n' },
                isWorkingCopy: true,
            },
        ]);

        const commitBId = ids['B'].commitId;
        const arg = { commitId: commitBId };

        await absorbCommand(scmProvider, jj, [arg]);

        // Verify A has the change
        const contentA = repo.getFileContent(ids['A'].changeId, fileName);
        expect(contentA).toBe('base\nlineA modified\n');
        
        expect(scmProvider.refresh).toHaveBeenCalled();
    }, 20000);
});
