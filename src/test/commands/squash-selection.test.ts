/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { squashHunkIntoParentCommand, squashSelectionIntoParentCommand } from '../../commands/squash-selection';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

// Mock VS Code
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showInformationMessage: vi.fn(),
            showWarningMessage: vi.fn(),
        },
        commands: {
            executeCommand: vi.fn(),
        },
    });
});

describe('squash-selection commands', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            provideOriginalResource: vi.fn(),
            outputChannel: createMock<vscode.OutputChannel>({
                appendLine: vi.fn(),
            }),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    describe('squashHunkIntoParentCommand', () => {
        test('squashes hunk based on index', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { 'initial.txt': 'initial' },
                },
                {
                    label: 'base',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nline2\nline3\nline4\nline5\n',
                        'other.txt': 'original other',
                    },
                },
                {
                    label: 'side',
                    parents: ['base'],
                    files: { 'side.txt': 'side' },
                },
                {
                    label: 'modified',
                    parents: ['base'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\nmodified4\nline5\n',
                        'other.txt': 'modified other',
                    },
                },
            ]);
            repo.edit(ids.modified.changeId);

            const uri = vscode.Uri.file(path.join(repo.path, fileName));
            const changes = [
                {
                    originalStartLineNumber: 2,
                    originalEndLineNumber: 2,
                    modifiedStartLineNumber: 2,
                    modifiedEndLineNumber: 2,
                },
                {
                    originalStartLineNumber: 4,
                    originalEndLineNumber: 4,
                    modifiedStartLineNumber: 4,
                    modifiedEndLineNumber: 4,
                },
            ];

            // Squash the second hunk (index 1: line 4)
            await squashHunkIntoParentCommand(scmProvider, jj, uri, changes, 1);

            // Verify state
            // Parent should have the second modification (line 4)
            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('line1\nline2\nline3\nmodified4\nline5\n');

            // Working copy should still have BOTH modifications (one from parent, one local)
            const wcContent = repo.getFileContent('@', fileName);
            expect(wcContent).toBe('line1\nmodified2\nline3\nmodified4\nline5\n');

            // Diff should only show the first modification (line 2)
            // Use --git diff to avoid context lines in the check
            const wcDiffGit = repo.getDiff('@', { git: true });
            expect(wcDiffGit).toContain('+modified2');
            expect(wcDiffGit).not.toContain('+modified4');

            expect(scmProvider.refresh).toHaveBeenCalled();
        });
    });

    describe('squashSelectionIntoParentCommand', () => {
        test('squashes selection from editor', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { 'initial.txt': 'initial' },
                },
                {
                    label: 'base',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nline2\nline3\nline4\nline5\n',
                        'other.txt': 'original other',
                    },
                },
                {
                    label: 'side',
                    parents: ['base'],
                    files: { 'side.txt': 'side' },
                },
                {
                    label: 'modified',
                    parents: ['base'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\nmodified4\nline5\n',
                        'other.txt': 'modified other',
                    },
                },
            ]);
            repo.edit(ids.modified.changeId);

            const uri = vscode.Uri.file(path.join(repo.path, fileName)).with({
                query: 'jj-revision=@',
            });

            // Select the first modification (line 2, which is line 1 in Position)
            const mockEditor = createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({
                    uri,
                }),
                selections: [new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 10))],
            });

            await squashSelectionIntoParentCommand(scmProvider, jj, mockEditor);

            // Select was first modification (line 2)
            // Parent should have the first modification
            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('line1\nmodified2\nline3\nline4\nline5\n');

            // Diff should only show the second modification (line 4)
            // Use --git diff to avoid context lines in the check
            const wcDiffGit = repo.getDiff('@', { git: true });
            expect(wcDiffGit).toContain('+modified4');
            expect(wcDiffGit).not.toContain('+modified2');

            expect(scmProvider.refresh).toHaveBeenCalled();
        });
    });
});

import * as path from 'node:path';
