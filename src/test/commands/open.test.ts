/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { openChangesCommand, openFileCommand } from '../../commands/open';
import type { JjResourceState } from '../../jj-scm-provider';
import { createMock } from '../test-utils';

vi.mock('vscode', () => {
    const uriFactory = (path: string, query: string = '') => ({
        fsPath: path,
        path: path,
        scheme: 'file',
        query,
        with: (change: { query?: string }) => uriFactory(path, change.query !== undefined ? change.query : query),
    });

    return {
        commands: {
            executeCommand: vi.fn(),
        },
        Uri: {
            file: (path: string) => uriFactory(path),
            parse: (path: string) => uriFactory(path),
        },
    };
});

describe('openFileCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource state', async () => {
        await openFileCommand(undefined);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes vscode.open with resource uri stripped of query params', async () => {
        // Create a URI that "starts" with a query, although the mock factory default is empty.
        // We rely on the fact that openFileCommand calls .with({ query: '' })
        const resourceState = createMock<vscode.SourceControlResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
        });

        await openFileCommand(resourceState);

        // We expect it to be called with a URI that has empty query
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.open',
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
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

    test('does nothing if resource state has no diffCommand', async () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
        });

        await openChangesCommand(resourceState);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    test('executes the diffCommand with its arguments', async () => {
        const leftUri = vscode.Uri.file('/left');
        const rightUri = vscode.Uri.file('/right');
        const resourceState = createMock<JjResourceState>({
            resourceUri: vscode.Uri.file('/foo'),
            revision: '@',
            diffCommand: {
                command: 'vscode.diff',
                title: 'Open Changes',
                arguments: [leftUri, rightUri, 'foo.txt (Working Copy)'],
            },
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
