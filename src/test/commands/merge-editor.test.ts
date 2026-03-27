/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { openMergeEditorCommand } from '../../commands/merge-editor';
import { JjScmProvider } from '../../jj-scm-provider';
import { asMock, createMock } from '../test-utils';

vi.mock('vscode', () => ({
    window: {
        showErrorMessage: vi.fn(),
    },
    Uri: { fsPath: '/path' },
}));

describe('openMergeEditorCommand', () => {
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        scmProvider = createMock<JjScmProvider>({
            openMergeEditor: vi.fn(),
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resources provided', async () => {
        // Mock console.warn to avoid clutter output
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await openMergeEditorCommand(scmProvider, undefined);

        expect(scmProvider.openMergeEditor).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('jj-view.openMergeEditor: No valid resource states provided');

        warnSpy.mockRestore();
    });

    test('calls openMergeEditor with resource states', async () => {
        const resource = { resourceUri: { fsPath: 'foo' } };
        await openMergeEditorCommand(scmProvider, resource);

        expect(scmProvider.openMergeEditor).toHaveBeenCalledWith([resource]);
    });

    test('handles error', async () => {
        const resource = { resourceUri: { fsPath: 'foo' } };
        asMock(scmProvider.openMergeEditor).mockRejectedValue(new Error('boom'));

        await openMergeEditorCommand(scmProvider, resource);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Error opening merge editor: boom'),
            'Show Log',
        );
    });
});
