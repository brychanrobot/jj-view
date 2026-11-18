/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { HostDocuments, HostEnvironment } from '../../src/core/host/host-environment';
import { Uri } from '../../src/core/uri-utils';
import {
    createRemoteFileUrlPayload,
    enrichWebRemoteFilePayload,
    resolveActiveTabDocumentSelections,
    resolveActiveTabDocumentUri,
} from '../src/commands/payloads/remote-file-url.payload';
import type { TabEntry } from '../src/tabs/tab-types';
import { createMock } from './test-mock';

describe('web remote file url payloads', () => {
    it('extracts explicit payloads, SCM resource states, and active documents with 1-based selections', () => {
        const revUri = Uri.parse('jj-view:///src/app.ts#mode=revision&root=/repo&revision=abc123');
        expect(createRemoteFileUrlPayload([{ menuId: 'editor/context', resourceUri: revUri }])).toEqual({
            fileUri: revUri,
            filePath: undefined,
            isRepoRelative: undefined,
            revision: undefined,
            fileStatus: undefined,
            lineRange: undefined,
            skipActiveSelection: false,
        });

        const wcFileUri = Uri.file('/repo/src/app.ts');
        expect(
            createRemoteFileUrlPayload([
                {
                    resourceUri: wcFileUri,
                    revision: 'working-copy-change-id',
                    status: 'modified',
                },
            ]),
        ).toEqual({
            fileUri: wcFileUri,
            revision: undefined,
            fileStatus: 'modified',
            skipActiveSelection: true,
        });

        const host = createMock<HostEnvironment>({
            documents: createMock<HostDocuments>({
                getActiveDocumentUri: () => revUri,
                getActiveDocumentSelections: () => [{ startLine: 2, endLine: 6 }],
            }),
        });
        expect(createRemoteFileUrlPayload([], host)).toEqual({
            fileUri: revUri,
            lineRange: { startLine: 3, endLine: 7 },
        });
    });

    it('resolves diff left/right sides, fileStatus, and multi-diff entries for active tabs and editor/context', () => {
        const leftUri = Uri.parse('jj-view:///old/a.ts#mode=diff&root=/repo&base=rev1&side=left');
        const rightUri = Uri.parse('jj-view:///new/a.ts#mode=diff&root=/repo&base=rev1&side=right');

        const diffTab: TabEntry = {
            id: 'tab-diff',
            title: 'a.ts',
            preview: false,
            view: {
                type: 'diff',
                title: 'a.ts',
                leftUri,
                rightUri,
                resourceState: {
                    resourceUri: rightUri,
                    revision: 'rev1',
                    status: 'deleted',
                },
            },
        };

        expect(resolveActiveTabDocumentUri(diffTab)?.toString()).toBe(rightUri.toString());
        expect(
            resolveActiveTabDocumentUri(diffTab, {
                filename: 'a.ts',
                side: 'deletions',
                selectedText: 'line',
            })?.toString(),
        ).toBe(leftUri.toString());

        expect(
            resolveActiveTabDocumentSelections(undefined, {
                filename: 'a.ts',
                startLine: 4,
                endLine: 8,
                selectedText: 'lines',
            }),
        ).toEqual([{ startLine: 3, endLine: 7 }]);

        const enrichedDiff = enrichWebRemoteFilePayload({
            commandId: 'jj-view.copyRemoteFileUrl',
            payload: { menuId: 'editor/context', resourceUri: { scheme: 'jj-view', path: '/new/a.ts' } },
            activeTab: diffTab,
            editorSelection: { filename: 'a.ts', side: 'deletions', startLine: 5, selectedText: 'old line' },
            activeTabSelection: undefined,
        });
        expect(enrichedDiff).toMatchObject({
            resourceUri: leftUri,
            fileStatus: 'deleted',
            lineRange: { startLine: 5, endLine: 5 },
            skipActiveSelection: true,
        });

        const multiLeftUri = Uri.parse('jj-view:///first.ts#mode=diff&root=/repo&base=rev2&side=left');
        const multiRightUri = Uri.parse('jj-view:///second.ts#mode=diff&root=/repo&base=rev2&side=right');
        const multiTab: TabEntry = {
            id: 'tab-multi',
            title: 'Commit rev2',
            preview: false,
            view: {
                type: 'multi-diff',
                title: 'Commit rev2',
                files: [
                    {
                        filename: 'first.ts',
                        fileStatus: 'modified',
                        leftUri: multiLeftUri,
                        rightUri: Uri.parse('jj-view:///first.ts#mode=diff&root=/repo&base=rev2&side=right'),
                    },
                    {
                        filename: 'second.ts',
                        fileStatus: 'deleted',
                        leftUri: Uri.parse('jj-view:///second.ts#mode=diff&root=/repo&base=rev2&side=left'),
                        rightUri: multiRightUri,
                    },
                ],
            },
        };

        const enrichedMulti = enrichWebRemoteFilePayload({
            commandId: 'jj-view.openFileOnRemote',
            payload: { menuId: 'editor/context' },
            activeTab: multiTab,
            editorSelection: {
                filename: 'second.ts',
                resourceUri: multiRightUri,
                fileStatus: 'deleted',
                startLine: 2,
                endLine: 4,
                selectedText: 'sel',
            },
            activeTabSelection: undefined,
        });
        expect(enrichedMulti).toMatchObject({
            resourceUri: multiRightUri,
            fileStatus: 'deleted',
            lineRange: { startLine: 2, endLine: 4 },
            skipActiveSelection: true,
        });
    });
});
