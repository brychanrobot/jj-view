/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { squashHunkIntoParentCommand, squashSelectionIntoParentCommand } from '../../commands/squash-selection';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import type { JjLoggerChannel } from '../../utils/output-channel';
import {
    createSquashHunkIntoParentPayload,
    createSquashSelectionIntoParentPayload,
} from '../../vscode/payloads/squash-selection.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

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
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
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

            const uri = Uri.file(path.join(repo.path, fileName));
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

            const payload = createSquashHunkIntoParentPayload([uri, changes, 1]);
            await squashHunkIntoParentCommand(ctx, payload);

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('line1\nline2\nline3\nmodified4\nline5\n');

            const wcContent = repo.getFileContent('@', fileName);
            expect(wcContent).toBe('line1\nmodified2\nline3\nmodified4\nline5\n');

            const wcDiffGit = repo.getDiff('@', { git: true });
            expect(wcDiffGit).toContain('+modified2');
            expect(wcDiffGit).not.toContain('+modified4');
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

            const uri = Uri.file(path.join(repo.path, fileName)).with({
                query: 'jj-revision=@',
            });

            const mockEditor = createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({
                    uri,
                }),
                selections: [new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 10))],
            });

            const payload = createSquashSelectionIntoParentPayload(mockEditor);
            await squashSelectionIntoParentCommand(ctx, payload);

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('line1\nmodified2\nline3\nline4\nline5\n');

            const wcDiffGit = repo.getDiff('@', { git: true });
            expect(wcDiffGit).toContain('+modified4');
            expect(wcDiffGit).not.toContain('+modified2');
        });

        test('squashes selection from jj-edit editor', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { [fileName]: 'line1\nline2\nline3\n' },
                },
                {
                    label: 'modified',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\n',
                    },
                },
            ]);

            const uri = Uri.file(path.join(repo.path, fileName)).with({
                scheme: 'jj-edit',
                query: `revision=${ids.modified.changeId}`,
            });

            const mockEditor = createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({
                    uri,
                }),
                selections: [new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 10))],
            });

            const payload = createSquashSelectionIntoParentPayload(mockEditor);
            await squashSelectionIntoParentCommand(ctx, payload);

            const parentContent = repo.getFileContent(ids.root.changeId, fileName);
            expect(parentContent).toBe('line1\nmodified2\nline3\n');
        });

        test('squashes selection from jj-view diff editor', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'root',
                    files: { [fileName]: 'line1\nline2\nline3\n' },
                },
                {
                    label: 'modified',
                    parents: ['root'],
                    files: {
                        [fileName]: 'line1\nmodified2\nline3\n',
                    },
                },
            ]);

            const uri = Uri.file(path.join(repo.path, fileName)).with({
                scheme: 'jj-view',
                query: `base=${ids.modified.changeId}&side=right`,
            });

            const mockEditor = createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({
                    uri,
                }),
                selections: [new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 10))],
            });

            const payload = createSquashSelectionIntoParentPayload(mockEditor);
            await squashSelectionIntoParentCommand(ctx, payload);

            const parentContent = repo.getFileContent(ids.root.changeId, fileName);
            expect(parentContent).toBe('line1\nmodified2\nline3\n');
        });
    });
});
