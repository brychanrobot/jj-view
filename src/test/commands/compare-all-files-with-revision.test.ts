/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { compareAllFilesWithRevisionCommand } from '../../commands/compare-all-files-with-revision';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { Uri } from '../../uri-utils';
import { createCompareAllFilesWithRevisionPayload } from '../../vscode/payloads/compare-all-files-with-revision.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

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
    let mockOutputChannel: vscode.LogOutputChannel;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj });
        mockOutputChannel = createMockLogOutputChannel({ appendLine: vi.fn(), show: vi.fn(), error: vi.fn() });
        ctx = new VSCodeCommandContext(mockJjRepo, mockOutputChannel, createMock<CommentsManager>({}));
    });

    afterEach(() => {
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

        const payload = createCompareAllFilesWithRevisionPayload([parentId]);
        await compareAllFilesWithRevisionCommand(ctx, payload);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.changes',
            expect.stringContaining('Compare'),
            expect.any(Array),
        );

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find((c) => c[0] === 'vscode.changes');
        const resourceTuples = call?.[2] as [Uri, Uri, Uri][];

        const simplified = resourceTuples.map((t) => ({
            path: path.basename(t[0].fsPath),
            leftScheme: t[1].scheme,
            leftFragment: t[1].fragment,
            rightScheme: t[2].scheme,
            rightFragment: t[2].fragment,
        }));
        simplified.sort((a, b) => a.path.localeCompare(b.path));

        expect(simplified[0].leftScheme).toBe('jj-view');
        expect(simplified[0].leftFragment).toContain(`revision=${parentId}`);
        expect(simplified[0].rightScheme).toBe('file');

        expect(simplified[1].leftScheme).toBe('jj-view');
        expect(simplified[1].leftFragment).toContain(`revision=${parentId}`);
        expect(simplified[1].rightScheme).toBe('jj-view');
        expect(simplified[1].rightFragment).toContain('revision=none');

        expect(simplified[2].leftScheme).toBe('jj-view');
        expect(simplified[2].leftFragment).toContain('revision=none');
        expect(simplified[2].rightScheme).toBe('file');
    });

    it('shows info message when no differences are found', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file1.txt': 'v1\n' } }]);
        const parentId = ids.v1.changeId;

        const payload = createCompareAllFilesWithRevisionPayload([parentId]);
        await compareAllFilesWithRevisionCommand(ctx, payload);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            `No differences found between ${parentId} and working copy.`,
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});
