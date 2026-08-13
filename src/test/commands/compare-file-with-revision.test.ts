/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { compareFileWithRevisionCommand } from '../../commands/compare-file-with-revision';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { createCompareFileWithRevisionPayload } from '../../vscode/payloads/compare-file-with-revision.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';
import { resetMockQuickPick, setActiveItems, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: { executeCommand: vi.fn() },
    });
});

describe('compareFileWithRevisionCommand', () => {
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

    it('opens vscode.diff comparing right clicked file', async () => {
        repo.writeFile('file1.txt', 'content');
        const fileUri = Uri.file(`${repo.path}/file1.txt`);

        const mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);

        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
        setSelectedItems(mockQuickPick, [{ label: 'main', detail: 'main' }]);
        setActiveItems(mockQuickPick, [{ label: 'main', detail: 'main' }]);

        const payload = createCompareFileWithRevisionPayload([fileUri]);
        await compareFileWithRevisionCommand(ctx, payload);

        const call = vi.mocked(vscode.commands.executeCommand).mock.calls.find((c) => c[0] === 'vscode.diff');
        const simplifiedCall = call
            ? [
                  call[0],
                  {
                      scheme: (call[1] as Uri).scheme,
                      fragment: (call[1] as Uri).fragment,
                  },
                  call[2],
                  call[3],
              ]
            : null;

        expect(simplifiedCall?.[0]).toBe('vscode.diff');
        expect(simplifiedCall?.[1].scheme).toBe('jj-view');
        expect(simplifiedCall?.[1].fragment).toContain('revision=main');
        expect(simplifiedCall?.[2]).toEqual(fileUri);
        expect(simplifiedCall?.[3]).toBe('file1.txt (main ↔ Working Copy)');
    });
});
