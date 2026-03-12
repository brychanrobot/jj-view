/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import * as path from 'path';
import { squashIntoCommand } from '../../commands/squash-into';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

// Mock VS Code
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showQuickPick: vi.fn(),
            showInformationMessage: vi.fn(),
        },
        workspace: {
            getConfiguration: () => ({
                get: (_key: string, defaultValue: unknown) => defaultValue
            })
        }
    });
});

describe('squashIntoCommand', () => {
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
                appendLine: vi.fn()
            })
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('shows information message if no mutable ancestors exist', async () => {
        const fileName = 'file.txt';
        // Just use the initial commit created by repo.init()
        repo.writeFile(fileName, 'child content');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await squashIntoCommand(scmProvider, jj, args);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No mutable ancestors available to squash into.');
        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });

    test('squashes specific file into grandparent', async () => {
        const fileName = 'file.txt';
        const ids = await buildGraph(repo, [
            { label: 'grandparent', description: 'grandparent', files: { [fileName]: 'grandparent content' } },
            { label: 'parent', parents: ['grandparent'], description: 'parent', files: { 'parent_file.txt': 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { [fileName]: 'child content', 'other.txt': 'other content' },
                isWorkingCopy: true,
            },
        ]);

        const grandparentCommitId = ids['grandparent'].commitId;
        const grandparentChangeId = ids['grandparent'].changeId;

        // Mock QuickPick to return grandparent
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: grandparentCommitId,
            label: 'Ancestor 2',
        });

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        // Provide the file uri to squash
        const args = [{ resourceUri: fileUri }];

        await squashIntoCommand(scmProvider, jj, args);

        expect(vscode.window.showQuickPick).toHaveBeenCalled();
        
        // Grandparent should have 'child content'
        const gpContent = repo.getFileContent(grandparentChangeId, fileName);
        expect(gpContent).toBe('child content');

        // Other file should remain in child
        const childOtherContent = repo.getFileContent('@', 'other.txt');
        expect(childOtherContent).toBe('other content');

        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('squashes all changes into selected ancestor', async () => {
        const fileName = 'file.txt';
        const ids = await buildGraph(repo, [
            { label: 'grandparent', description: 'grandparent', files: { [fileName]: 'grandparent content' } },
            { label: 'parent', parents: ['grandparent'], description: 'parent', files: { 'parent_file.txt': 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { [fileName]: 'child content', 'other.txt': 'child other' },
                isWorkingCopy: true,
            },
        ]);

        const grandparentCommitId = ids['grandparent'].commitId;
        const grandparentChangeId = ids['grandparent'].changeId;

        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: grandparentCommitId,
            label: 'Ancestor 2',
        });

        // Pass empty args to trigger all changes squash
        await squashIntoCommand(scmProvider, jj, []);

        expect(vscode.window.showQuickPick).toHaveBeenCalled();

        // Both files should be empty/deleted in child, or moved to grandparent
        const gpContent = repo.getFileContent(grandparentChangeId, fileName);
        expect(gpContent).toBe('child content');

        const gpOtherContent = repo.getFileContent(grandparentChangeId, 'other.txt');
        expect(gpOtherContent).toBe('child other');
    });
});
