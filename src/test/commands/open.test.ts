/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { openChangesCommand, openFileCommand } from '../../commands/open';
import type { JjResourceState } from '../../scm-resource-state';
import { createMock } from '../test-utils';
import { setActiveTextEditor } from '../vscode-mock';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('openFileCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
        setActiveTextEditor(undefined);
    });

    test('does nothing if no args and no active text editor', async () => {
        await openFileCommand();
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes vscode.open from SourceControlResourceState', async () => {
        const resourceState = createMock<vscode.SourceControlResourceState>({
            resourceUri: vscode.Uri.parse('file:///foo?jj-revision=@'),
        });

        await openFileCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        );
    });

    test('executes vscode.open from a historical URI (jj-view scheme)', async () => {
        const uri = vscode.Uri.parse('jj-view:///foo/bar.txt?base=c123&side=left');

        await openFileCommand(uri);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo/bar.txt',
                query: '',
            }),
        );
    });

    test('executes vscode.open from activeTextEditor fallback when args are empty', async () => {
        setActiveTextEditor(
            createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({
                    uri: vscode.Uri.parse('jj-edit:///baz/qux.ts?revision=rev123'),
                }),
            }),
        );

        await openFileCommand();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/baz/qux.ts',
                query: '',
            }),
        );
    });
});

describe('openChangesCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource state', async () => {
        await openChangesCommand(undefined);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('does nothing if resource state has no leftUri or rightUri', async () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
        });

        await openChangesCommand(resourceState);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes the diffCommand with its URIs and title', async () => {
        const leftUri = vscode.Uri.file('/left');
        const rightUri = vscode.Uri.file('/right');
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
            leftUri,
            rightUri,
            diffTitle: 'foo.txt (Working Copy)',
        });

        await openChangesCommand(resourceState);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.diff',
            leftUri,
            rightUri,
            'foo.txt (Working Copy)',
        );
    });
});
