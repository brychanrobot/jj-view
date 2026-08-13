/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { openChangesCommand, openFileCommand } from '../../commands/open';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import type { JjResourceState } from '../../scm-resource-state';
import { Uri } from '../../uri-utils';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createOpenChangesPayload } from '../../vscode/payloads/open-changes.payload';
import { createOpenFilePayload } from '../../vscode/payloads/open-file.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { createMock } from '../test-utils';
import { setActiveTextEditor } from '../vscode-mock';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('openFileCommand', () => {
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        ctx = new VSCodeCommandContext(
            createMock<JjRepository>({}),
            createMock<JjLoggerChannel>({}),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
        setActiveTextEditor(undefined);
    });

    test('does nothing if no args and no active text editor', async () => {
        const payload = createOpenFilePayload([]);
        await openFileCommand(ctx, payload);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes vscode.open from SourceControlResourceState', async () => {
        const resourceState = createMock<vscode.SourceControlResourceState>({
            resourceUri: Uri.parse('file:///foo?jj-revision=@'),
        });

        const payload = createOpenFilePayload([resourceState]);
        await openFileCommand(ctx, payload);

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
        const uri = Uri.parse('jj-view:///foo/bar.txt?base=c123&side=left');

        const payload = createOpenFilePayload([uri]);
        await openFileCommand(ctx, payload);

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
                    uri: Uri.parse('jj-edit:///baz/qux.ts?revision=rev123'),
                }),
            }),
        );

        const payload = createOpenFilePayload([]);
        await openFileCommand(ctx, payload);

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
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        ctx = new VSCodeCommandContext(
            createMock<JjRepository>({}),
            createMock<JjLoggerChannel>({}),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource state', async () => {
        const payload = createOpenChangesPayload([undefined]);
        await openChangesCommand(ctx, payload);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('does nothing if resource state has no leftUri or rightUri', async () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: Uri.file('/foo'),
            revision: '@',
        });

        const payload = createOpenChangesPayload([resourceState]);
        await openChangesCommand(ctx, payload);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes the diffCommand with its URIs and title', async () => {
        const leftUri = Uri.file('/left');
        const rightUri = Uri.file('/right');
        const resourceState = createMock<JjResourceState>({
            resourceUri: Uri.file('/foo'),
            revision: '@',
            leftUri,
            rightUri,
            diffTitle: 'foo.txt (Working Copy)',
        });

        const payload = createOpenChangesPayload([resourceState]);
        await openChangesCommand(ctx, payload);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.diff',
            leftUri,
            rightUri,
            'foo.txt (Working Copy)',
        );
    });
});
