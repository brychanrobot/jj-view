/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import * as path from 'path';
import { squashChangeCommand } from '../../commands/squash-change';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import { JjDocumentContentProvider } from '../../jj-content-provider';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    Uri: {
        file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => `file://${filePath}`,
            with: () => ({ scheme: 'jj-view', query: 'revision=@-' }),
        }),
    },
    window: {
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        activeTextEditor: undefined,
    },
    commands: {
        executeCommand: vi.fn(),
    },
}));

describe('squashChangeCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            contentProvider: createMock<JjDocumentContentProvider>({ update: vi.fn() }),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('squashes addition to parent', async () => {
        const fileName = 'squash.txt';

        // Parent has base content
        repo.writeFile(fileName, 'line1\n');
        repo.describe('parent');
        repo.new();

        // Child adds a line
        repo.writeFile(fileName, 'line1\nline2\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // LineChange for an addition: line 2 added (1-indexed)
        const changes = [
            {
                originalStartLineNumber: 2,
                originalEndLineNumber: 0, // Empty in original (addition)
                modifiedStartLineNumber: 2,
                modifiedEndLineNumber: 2,
            },
        ];

        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        // Parent should now have the added line
        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent.trim()).toBe('line1\nline2');

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Squashed change to parent.');
    });

    test('squashes deletion to parent', async () => {
        const fileName = 'delete.txt';

        // Parent has two lines
        repo.writeFile(fileName, 'keep\ndelete\n');
        repo.describe('parent');
        repo.new();

        // Child deletes the second line
        repo.writeFile(fileName, 'keep\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // LineChange for a deletion: line 2 deleted
        // For deletions: modifiedEndLineNumber < modifiedStartLineNumber
        const changes = [
            {
                originalStartLineNumber: 2,
                originalEndLineNumber: 2,
                modifiedStartLineNumber: 1, // Deletion occurs after line 1
                modifiedEndLineNumber: 0, // Empty in modified (deletion)
            },
        ];

        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        // Parent should now have only "keep\n"
        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent.trim()).toBe('keep');

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Squashed change to parent.');
    });

    test('squashes modification to parent', async () => {
        const fileName = 'modify.txt';

        // Parent has original content
        repo.writeFile(fileName, 'original\n');
        repo.describe('parent');
        repo.new();

        // Child modifies the line
        repo.writeFile(fileName, 'modified\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // LineChange for a modification: line 1 changed
        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 1,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
        ];

        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        // Parent should now have modified content
        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent.trim()).toBe('modified');

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Squashed change to parent.');
    });

    test('shows warning when change is outside JJ hunks', async () => {
        const fileName = 'outside.txt';

        // Parent has content
        repo.writeFile(fileName, 'line1\nline2\n');
        repo.describe('parent');
        repo.new();

        // Child modifies line 1 only
        repo.writeFile(fileName, 'modified1\nline2\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // LineChange pointing to line 10, which is way outside the actual hunk
        const changes = [
            {
                originalStartLineNumber: 10,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 10,
                modifiedEndLineNumber: 10,
            },
        ];

        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        // Should show warning about change not being in hunk
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            'This change cannot be squashed separately. It may be a newline or whitespace change at the end of the file.',
        );

        // Should NOT show success message
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    test('shows warning when file has no diff from JJ perspective', async () => {
        const fileName = 'nodiff.txt';

        // Parent and child have identical content
        repo.writeFile(fileName, 'same\n');
        repo.describe('parent');
        repo.new();
        // Don't modify anything

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // VS Code thinks there's a change but JJ doesn't
        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
        ];

        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        // Should show warning about invisible change
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            'This change is not visible to JJ. It may be a whitespace or newline difference.',
        );
    });

    test('returns early with invalid arguments', async () => {
        const fileName = 'invalid.txt';
        repo.writeFile(fileName, 'content\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // Test with null uri
        await squashChangeCommand(scmProvider, jj, null as unknown as vscode.Uri, [], 0);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

        // Test with invalid index
        await squashChangeCommand(scmProvider, jj, fileUri, [], 0);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

        // Test with non-array changes
        await squashChangeCommand(scmProvider, jj, fileUri, 'invalid', 0);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    test('refreshes SCM provider on success', async () => {
        const fileName = 'refresh.txt';

        repo.writeFile(fileName, 'line1\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'line1\nline2\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        const changes = [
            {
                originalStartLineNumber: 2,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 2,
                modifiedEndLineNumber: 2,
            },
        ];

        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('does not refresh on failure', async () => {
        const fileName = 'nofail.txt';

        // No diff exists for this file
        repo.writeFile(fileName, 'content\n');
        repo.describe('parent');
        repo.new();

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // Phantom change
        const changes = [
            {
                originalStartLineNumber: 5,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 5,
                modifiedEndLineNumber: 5,
            },
        ];

        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        // Should NOT refresh because the operation didn't succeed
        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });
});
