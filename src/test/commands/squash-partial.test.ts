/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { squashPartialCommand, squashToParentInDiffCommand } from '../../commands/squash-partial';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showQuickPick: vi.fn(),
            showInformationMessage: vi.fn(),
            showWarningMessage: vi.fn(),
            activeTextEditor: undefined,
        },
    });
});

describe('Squash Partial Commands', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            provideOriginalResource: (uri: vscode.Uri) => uri.with({ scheme: 'jj-view', query: 'base=@&side=left' }),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    describe('squashToParentInDiffCommand', () => {
        test('squashes selected lines from diff editor', async () => {
            const fileName = 'diff.txt';
            await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'line 1\ncontext\ncontext\ncontext\nline 2\n' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'line 1 mod\ncontext\ncontext\ncontext\nline 2 mod\n' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName)).with({ query: 'jj-revision=@' });
            const editor = createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({ uri: fileUri }),
                selections: [new vscode.Selection(0, 0, 0, 0)], // Select line 1
            });

            await squashToParentInDiffCommand(scmProvider, jj, editor);

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toContain('line 1 mod');
            expect(parentContent).toContain('\nline 2\n'); // Line 2 should be unchanged in parent
            expect(scmProvider.refresh).toHaveBeenCalled();
        }, 30000);
    });

    describe('squashPartialCommand', () => {
        test('squashes specific hunk from gutter', async () => {
            const fileName = 'gutter.txt';
            await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'line 1\ncontext\ncontext\ncontext\nline 2\n' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'line 1 mod\ncontext\ncontext\ncontext\nline 2 mod\n' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
            const changes = [
                {
                    originalStartLineNumber: 1,
                    originalEndLineNumber: 1,
                    modifiedStartLineNumber: 1,
                    modifiedEndLineNumber: 1,
                },
            ];

            await squashPartialCommand(scmProvider, jj, fileUri, changes, 0);

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toContain('line 1 mod');
            expect(parentContent).toContain('\nline 2\n');
            expect(scmProvider.refresh).toHaveBeenCalled();
        }, 30000);

        test('shows warning if change is not visible to JJ', async () => {
            const fileName = 'no-diff.txt';
            await buildGraph(repo, [
                { label: 'parent', description: 'parent', files: { [fileName]: 'content\n' } },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'content\n' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
            const changes = [
                {
                    modifiedStartLineNumber: 1,
                    modifiedEndLineNumber: 1,
                    originalStartLineNumber: 1,
                    originalEndLineNumber: 1,
                },
            ];

            await squashPartialCommand(scmProvider, jj, fileUri, changes, 0);

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('not visible to JJ'));
        }, 30000);
    });
});
