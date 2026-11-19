/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createDiffUris, type Uri } from '../core/uri-utils';
import { VsCodeHostNavigation } from '../vscode/vscode-host-environment';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

describe('VsCodeHostNavigation.openMultiDiff', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes matching URI paths to vscode.changes for modified working-copy files and distinct paths for genuine renames', async () => {
        const nav = new VsCodeHostNavigation();
        const root = '/tmp/parent/subrepo';

        const modifiedUris = createDiffUris({ path: 'cli/src/cli_util.rs', status: 'modified' }, 'wc123', root, {
            editable: true,
            workingCopyChangeId: 'wc123',
        });
        const renamedUris = createDiffUris(
            { path: 'new_name.txt', oldPath: 'old_name.txt', status: 'renamed' },
            'wc123',
            root,
            {
                editable: true,
                workingCopyChangeId: 'wc123',
            },
        );

        await nav.openMultiDiff('wc123: modify and rename', [
            {
                leftUri: modifiedUris.leftUri,
                rightUri: modifiedUris.rightUri,
                label: 'cli/src/cli_util.rs',
                status: 'modified',
            },
            {
                leftUri: renamedUris.leftUri,
                rightUri: renamedUris.rightUri,
                label: 'new_name.txt',
                oldLabel: 'old_name.txt',
                status: 'renamed',
            },
        ]);

        const executeCommandMock = vi.mocked(vscode.commands.executeCommand);
        expect(executeCommandMock).toHaveBeenCalledTimes(1);
        const [commandId, title, changes] = executeCommandMock.mock.calls[0] as [
            string,
            string,
            Array<[Uri, Uri, Uri]>,
        ];
        expect(commandId).toBe('vscode.changes');
        expect(title).toBe('wc123: modify and rename');
        expect(changes).toHaveLength(2);

        const [modLabelUri, modLeftUri, modRightUri] = changes[0];
        expect(modLabelUri.toString()).toBe(modRightUri.toString());
        expect(modLeftUri.scheme).toBe('jj-view');
        expect(modRightUri.scheme).toBe('file');
        expect(modLeftUri.path).toBe(modRightUri.path);

        const [renLabelUri, renLeftUri, renRightUri] = changes[1];
        expect(renLabelUri.toString()).toBe(renRightUri.toString());
        expect(renLeftUri.scheme).toBe('jj-view');
        expect(renRightUri.scheme).toBe('file');
        expect(renLeftUri.path).not.toBe(renRightUri.path);
        expect(renLeftUri.path).toBe('/tmp/parent/subrepo/old_name.txt');
        expect(renRightUri.path).toBe('/tmp/parent/subrepo/new_name.txt');
    });
});
