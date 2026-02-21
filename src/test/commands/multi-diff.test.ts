/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { showMultiFileDiffCommand } from '../../commands/multi-diff';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: { executeCommand: vi.fn() },
        window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
    });
});

describe('showMultiFileDiffCommand', () => {
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

    it('opens vscode.changes with correct 3-tuple URIs using change ID', async () => {
        const FILE_NAME = 'file1.txt';
        repo.writeFile(FILE_NAME, 'content 1');
        repo.describe('test commit description');
        const changeId = repo.getChangeId('@');

        await showMultiFileDiffCommand(jj, mockOutputChannel, changeId);

        expect(vscode.commands.executeCommand).toHaveBeenCalled();
        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find(
            c => c[0] === 'vscode.changes'
        );
        expect(call).toBeDefined();

        const [, title, resourceTuples] = call!;

        // Title should include short change ID and description
        expect(title).toContain(changeId.slice(0, 8));
        expect(title).toContain('test commit description');

        const tuples = resourceTuples as [vscode.Uri, vscode.Uri, vscode.Uri][];
        expect(tuples).toHaveLength(1);

        const [label, original, modified] = tuples[0];

        // Label should be the modified URI (display identifier)
        expect(label.path).toContain(FILE_NAME);

        // Original (left) should reference parent revision
        expect(original.scheme).toBe('jj-view');
        expect(original.query).toContain(`base=${changeId}`);
        expect(original.query).toContain('side=left');
        expect(original.path).toContain(FILE_NAME);

        // Modified (right) should use jj-view scheme (not file scheme)
        expect(modified.scheme).toBe('jj-view');
        expect(modified.query).toContain(`base=${changeId}`);
        expect(modified.query).toContain('side=right');
        expect(modified.path).toContain(FILE_NAME);
    });

    it('resolves @ to change ID', async () => {
        repo.writeFile('file.txt', 'content');
        const changeId = repo.getChangeId('@');

        await showMultiFileDiffCommand(jj, mockOutputChannel, '@');

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find(
            c => c[0] === 'vscode.changes'
        );
        expect(call).toBeDefined();

        const tuples = call![2] as [vscode.Uri, vscode.Uri, vscode.Uri][];
        expect(tuples).toHaveLength(1);

        // Modified side should use change ID, not '@'
        const modified = tuples[0][2];
        expect(modified.scheme).toBe('jj-view');
        expect(modified.query).toContain(`base=${changeId}`);
        expect(modified.query).toContain('side=right');
    });

    it('works with Webview Context payload', async () => {
        repo.writeFile('file1.txt', 'A');
        const commitId = repo.getCommitId('@');

        await showMultiFileDiffCommand(jj, mockOutputChannel, { commitId });

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find(
            c => c[0] === 'vscode.changes'
        );
        expect(call).toBeDefined();

        const tuples = call![2] as [vscode.Uri, vscode.Uri, vscode.Uri][];
        expect(tuples).toHaveLength(1);
    });

    it('shows info message when no changes found', async () => {
        await showMultiFileDiffCommand(jj, mockOutputChannel, '@');

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('No changes found')
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
            'vscode.changes',
            expect.anything(),
            expect.anything()
        );
    });
});
