/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { openMergeEditorCommand } from '../../commands/merge-editor';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { Uri } from '../../uri-utils';
import { createOpenMergeEditorPayload } from '../../vscode/payloads/merge-editor.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { createMock, createMockLogOutputChannel } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('openMergeEditorCommand', () => {
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        mockJjRepo = createMock<JjRepository>({
            rootUri: Uri.file('/test'),
        });
        ctx = new VSCodeCommandContext(mockJjRepo, createMockLogOutputChannel(), createMock<CommentsManager>({}));
        ctx.nav.openMergeEditor = vi.fn();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resources provided', async () => {
        const payload = createOpenMergeEditorPayload([undefined]);
        await openMergeEditorCommand(ctx, payload);

        expect(ctx.nav.openMergeEditor).not.toHaveBeenCalled();
    });

    test('calls openMergeEditor with resource states', async () => {
        const resourceUri = Uri.file('/test/foo.txt');
        const resource = { resourceUri };
        const payload = createOpenMergeEditorPayload([resource]);
        await openMergeEditorCommand(ctx, payload);

        expect(ctx.nav.openMergeEditor).toHaveBeenCalledWith(resourceUri);
    });

    test('handles error', async () => {
        const resourceUri = Uri.file('/test/foo.txt');
        const resource = { resourceUri };
        const openMergeEditor = ctx.nav.openMergeEditor;
        if (!openMergeEditor) {
            throw new Error('openMergeEditor not defined');
        }
        vi.mocked(openMergeEditor).mockRejectedValue(new Error('boom'));

        const payload = createOpenMergeEditorPayload([resource]);
        await openMergeEditorCommand(ctx, payload);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Error opening merge editor: boom'),
            'Show Log',
        );
    });
});
