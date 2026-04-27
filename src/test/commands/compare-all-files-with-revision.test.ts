/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { compareAllFilesWithRevisionCommand } from '../../commands/compare-all-files-with-revision';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: { executeCommand: vi.fn() },
        window: {
            showInformationMessage: vi.fn(),
            showErrorMessage: vi.fn(),
            showInputBox: vi.fn(),
            showQuickPick: vi.fn(),
        },
    });
});

describe('compareAllFilesWithRevisionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockOutputChannel: vscode.OutputChannel;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    it('opens vscode.changes with expected file list', async () => {
        const ids = await buildGraph(repo, [
            { label: 'v1', files: { 'file1.txt': 'v1\n', 'file2.txt': 'v1\n' } },
            { label: 'v2', parents: ['v1'], files: { 'file1.txt': 'v2\n' } },
        ]);
        const parentId = ids.v1.changeId;

        // Working copy changes
        repo.writeFile('file1.txt', 'wc\n');
        repo.deleteFile('file2.txt');
        repo.writeFile('file3.txt', 'unique added file\n');

        await compareAllFilesWithRevisionCommand(jj, mockOutputChannel, parentId);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.changes',
            expect.stringContaining('Compare'),
            expect.any(Array),
        );

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find((c) => c[0] === 'vscode.changes');
        const resourceTuples = call?.[2] as [vscode.Uri, vscode.Uri, vscode.Uri][];

        const simplified = resourceTuples.map((t) => ({
            path: path.basename(t[0].fsPath),
            leftScheme: t[1].scheme,
            leftQuery: t[1].query,
            rightScheme: t[2].scheme,
            rightQuery: t[2].query,
        }));
        simplified.sort((a, b) => a.path.localeCompare(b.path));

        expect(simplified).toEqual([
            {
                path: 'file1.txt',
                leftScheme: 'jj-view',
                leftQuery: `revision=${parentId}`,
                rightScheme: 'file',
                rightQuery: '',
            },
            {
                path: 'file2.txt',
                leftScheme: 'jj-view',
                leftQuery: `revision=${parentId}`,
                rightScheme: 'jj-view',
                rightQuery: 'revision=none',
            },
            {
                path: 'file3.txt',
                leftScheme: 'jj-view',
                leftQuery: 'revision=none',
                rightScheme: 'file',
                rightQuery: '',
            },
        ]);
    });
});
