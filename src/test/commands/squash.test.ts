/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import * as path from 'path';
import * as fs from 'fs';
import { squashCommand } from '../../commands/squash';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

// Mock VS Code
vi.mock('vscode', () => ({
    Uri: { file: (path: string) => ({ fsPath: path }) },
    window: {
        showQuickPick: vi.fn(),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showTextDocument: vi.fn(),
        withProgress: vi.fn().mockImplementation(async (_, task) => task()),
    },
    workspace: {
        openTextDocument: vi.fn(),
        textDocuments: [],
    },
    ProgressLocation: { Notification: 15 },
}));

describe('squashCommand', () => {
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

    test('squashes specific file to parent', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { [fileName]: 'child content' },
                isWorkingCopy: true,
            },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await squashCommand(scmProvider, jj, args);

        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('child content');
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('squashes all changes to parent (implicit)', async () => {
        const fileName = 'file.txt';

        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'parent content' } },
            { parents: ['parent'], description: '', files: { [fileName]: 'child content' } },
        ]);

        await squashCommand(scmProvider, jj, []);

        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('child content');
    });

    test('handles multiple parents by prompting user', async () => {
        const fileName = 'p1_file.txt';

        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'parent 1', files: { [fileName]: 'p1 content' } },
            { label: 'p2', description: 'parent 2', files: { 'p2_file.txt': 'p2 content' } },
            { parents: ['p1', 'p2'], description: '', files: { [fileName]: 'child modified' } },
        ]);

        const p1ChangeId = ids['p1'].changeId;
        const p1CommitId = ids['p1'].commitId;

        // Verify pre-state calling repo directly
        const parents = repo.getParents('@');
        expect(parents.length).toBe(2);
        expect(parents).toContain(p1ChangeId);

        // Mock QuickPick - must return commit_id in detail (that's what squashCommand builds)
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: p1CommitId,
            label: 'Parent 1',
        });

        await squashCommand(scmProvider, jj, []);

        expect(vscode.window.showQuickPick).toHaveBeenCalled();

        // Verify p1 content via repo (using change_id to reference the commit)
        const p1Content = repo.getFileContent(p1ChangeId, fileName);
        expect(p1Content).toBe('child modified');
    });

    test('triggers description editor when both have descriptions', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'Parent Description', files: { [fileName]: 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'Child Description',
                files: { [fileName]: 'child content' },
                isWorkingCopy: true,
            },
        ]);

        const mockDoc = createMock<vscode.TextDocument>({ uri: vscode.Uri.file('/tmp/SQUASH_MSG') });
        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc);

        await squashCommand(scmProvider, jj, []);

        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);

        const metaPath = path.join(repo.path, '.jj', 'vscode', 'SQUASH_META.json');
        expect(fs.existsSync(metaPath)).toBe(true);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        expect(meta.revision).toBe('@');
    });
});
