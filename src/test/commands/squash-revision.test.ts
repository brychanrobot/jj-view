/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { pickAncestor } from '../../commands/command-utils';
import { squashRevisionIntoAncestorCommand, squashRevisionIntoParentCommand } from '../../commands/squash-revision';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

// Mock VS Code
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showQuickPick: vi.fn(),
            showTextDocument: vi.fn(),
        },
        workspace: {
            openTextDocument: vi.fn(),
            textDocuments: [],
        },
    });
});

vi.mock('../../commands/command-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../commands/command-utils')>();
    return {
        ...actual,
        pickAncestor: vi.fn(),
    };
});

describe('squashRevisionIntoParentCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            getSquashStorageDir: vi.fn().mockReturnValue(path.join(repo.path, '.jj', 'vscode')),
            outputChannel: createMock<vscode.OutputChannel>({
                appendLine: vi.fn(),
            }),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('squashes all changes to parent (implicit)', async () => {
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
                description: '',
                files: { [fileName]: 'child content', 'other.txt': 'other modified' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await squashRevisionIntoParentCommand(scmProvider, jj, []);

        // Parent should have child's content for both files
        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('child content');

        const parentOther = repo.getFileContent('@-', 'other.txt');
        expect(parentOther).toBe('other modified');
    });

    test('handles multiple parents by prompting user', async () => {
        const fileName = 'p1_file.txt';

        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'parent 1', files: { [fileName]: 'p1 content' } },
            { label: 'p2', description: 'parent 2', files: { 'p2_file.txt': 'p2 content' } },
            { parents: ['p1', 'p2'], description: '', files: { [fileName]: 'child modified' } },
        ]);

        const p1ChangeId = ids.p1.changeId;
        const p1CommitId = ids.p1.commitId;

        // Verify pre-state calling repo directly
        const parents = repo.getParents('@');
        expect(parents.length).toBe(2);
        expect(parents).toContain(p1ChangeId);

        // Mock QuickPick - must return commit_id in detail
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: p1CommitId,
            label: 'Parent 1',
        });

        await squashRevisionIntoParentCommand(scmProvider, jj, []);

        expect(vscode.window.showQuickPick).toHaveBeenCalled();

        // Verify p1 content via repo
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
                isCurrentWorkingCopy: true,
            },
        ]);

        const mockDoc = createMock<vscode.TextDocument>({ uri: vscode.Uri.file('/tmp/SQUASH_MSG') });
        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc);

        await squashRevisionIntoParentCommand(scmProvider, jj, []);

        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);

        const storageDir = scmProvider.getSquashStorageDir();
        const metaPath = path.join(storageDir, 'SQUASH_META.json');
        expect(fs.existsSync(metaPath)).toBe(true);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        expect(meta.revision).toBe('@');
    });

    test('handles multiple parents for non-working copy revision', async () => {
        const fileName = 'p1_file.txt';
        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'parent 1', files: { [fileName]: 'p1 content' } },
            { label: 'p2', description: 'parent 2', files: { 'p2_file.txt': 'p2 content' } },
            {
                label: 'child',
                parents: ['p1', 'p2'],
                description: 'Child Description',
                files: { [fileName]: 'child modified' },
            },
            { label: 'tip', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        const childChangeId = ids.child.changeId;
        const p2CommitId = ids.p2.commitId;

        // Mock QuickPick to select p2
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: p2CommitId,
            label: 'Parent 2',
        });

        // Since both p2 and child have descriptions, it should open editor
        const mockDoc = createMock<vscode.TextDocument>({ uri: vscode.Uri.file('/tmp/SQUASH_MSG') });
        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc);

        await squashRevisionIntoParentCommand(scmProvider, jj, [childChangeId]);

        expect(vscode.window.showQuickPick).toHaveBeenCalled();
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);

        const storageDir = scmProvider.getSquashStorageDir();
        const meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'SQUASH_META.json'), 'utf-8'));
        expect(meta.revision).toBe(childChangeId);
        expect(meta.parentRev).toBe(p2CommitId);
    });

    test('uses child description when parent description is empty', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: '', files: { [fileName]: 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'Child Description',
                files: { [fileName]: 'child content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await squashRevisionIntoParentCommand(scmProvider, jj, []);

        // Should NOT open editor
        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();

        // Resulting parent should have child's description
        const parentDesc = repo.getDescription('@-');
        expect(parentDesc).toBe('Child Description');
    });

    test('uses parent description when child description is empty', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'Parent Description', files: { [fileName]: 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: '',
                files: { [fileName]: 'child content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await squashRevisionIntoParentCommand(scmProvider, jj, []);

        // Should NOT open editor
        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();

        // Resulting parent should have parent's description
        const parentDesc = repo.getDescription('@-');
        expect(parentDesc).toBe('Parent Description');
    });

    test('squashes into empty parent (preserves child desc)', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p1', description: '', files: { 'p1.txt': 'p1' } },
            { label: 'p2', description: 'Parent 2', files: { 'p2.txt': 'p2' } },
            {
                label: 'child',
                parents: ['p1', 'p2'],
                description: 'Child Description',
                files: { 'child.txt': 'child' },
                isCurrentWorkingCopy: true,
            },
        ]);

        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: ids.p1.commitId,
            label: 'Parent 1',
        });

        await squashRevisionIntoParentCommand(scmProvider, jj, []);
        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
        expect(repo.getDescription(ids.p1.changeId)).toBe('Child Description');
    });

    test('squashes into non-empty parent (triggers editor)', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p1', description: '', files: { 'p1.txt': 'p1' } },
            { label: 'p2', description: 'Parent 2', files: { 'p2.txt': 'p2' } },
            {
                label: 'child',
                parents: ['p1', 'p2'],
                description: 'Child Description',
                files: { 'child.txt': 'child' },
                isCurrentWorkingCopy: true,
            },
        ]);

        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: ids.p2.commitId,
            label: 'Parent 2',
        });
        const mockDoc = createMock<vscode.TextDocument>({ uri: vscode.Uri.file('/tmp/SQUASH_MSG') });
        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDoc);

        await squashRevisionIntoParentCommand(scmProvider, jj, []);
        expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    test('squashRevisionIntoParentCommand for non-working copy with no descriptions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p', description: '', files: { 'f.txt': 'p' } },
            { label: 'child', parents: ['p'], description: '', files: { 'f.txt': 'child' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        await squashRevisionIntoParentCommand(scmProvider, jj, [ids.child.changeId]);

        expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
        expect(repo.getDescription(ids.p.changeId)).toBe('');
    });

    test('squashRevisionIntoAncestorCommand picks ancestor and squashes', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'Base', files: { 'base.txt': 'base' } },
            { label: 'p', parents: ['base'], description: 'Parent', files: { 'p.txt': 'p' } },
            { label: 'child', parents: ['p'], description: '', files: { 'child.txt': 'child' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        // Mock pickAncestor to select 'base'
        vi.mocked(pickAncestor).mockResolvedValueOnce(ids.base.commitId);

        await squashRevisionIntoAncestorCommand(scmProvider, jj, [ids.child.changeId]);

        expect(pickAncestor).toHaveBeenCalledWith(expect.anything(), ids.child.changeId);

        // base should now have child's content
        expect(repo.getFileContent(ids.base.changeId, 'child.txt')).toBe('child');
    });

    test('squashRevisionIntoParentCommand handles root revision error', async () => {
        await buildGraph(repo, [
            { label: 'root', description: 'Root', files: { 'f.txt': 'root' } },
            { label: 'wc', parents: ['root'], isCurrentWorkingCopy: true },
        ]);

        await squashRevisionIntoParentCommand(scmProvider, jj, ['root()']);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Cannot squash a root revision.');
    });
});
