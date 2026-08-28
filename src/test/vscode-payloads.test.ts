/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { JjResourceState } from '../scm-resource-state';
import { Uri } from '../uri-utils';
import { createAbandonPayload } from '../vscode/payloads/abandon.payload';
import { createAbsorbPayload } from '../vscode/payloads/absorb.payload';
import { createSetBookmarkPayload } from '../vscode/payloads/bookmark.payload';
import { createAdvanceBookmarkPayload } from '../vscode/payloads/bookmark-advance.payload';
import { createAdvanceBookmarkAndUploadPayload } from '../vscode/payloads/bookmark-advance-upload.payload';
import { createCommitPayload, createCommitPromptPayload } from '../vscode/payloads/commit.payload';
import { createCompareAllFilesWithRevisionPayload } from '../vscode/payloads/compare-all-files-with-revision.payload';
import { createDescribePromptPayload, createSetDescriptionPayload } from '../vscode/payloads/describe.payload';
import { createShowDetailsPayload } from '../vscode/payloads/details.payload';
import { createDuplicatePayload } from '../vscode/payloads/duplicate.payload';
import { createEditPayload } from '../vscode/payloads/edit.payload';
import { createNewMergeChangePayload } from '../vscode/payloads/merge.payload';
import { createOpenMergeEditorPayload } from '../vscode/payloads/merge-editor.payload';
import { createShowMultiFileDiffPayload } from '../vscode/payloads/multi-diff.payload';
import { createNewPayload } from '../vscode/payloads/new.payload';
import { createNewAfterPayload } from '../vscode/payloads/new-after.payload';
import { createNewBeforePayload } from '../vscode/payloads/new-before.payload';
import { createRebaseOntoSelectedPayload } from '../vscode/payloads/rebase.payload';
import { createRestorePayload } from '../vscode/payloads/restore.payload';
import {
    createSquashFilesIntoAncestorPayload,
    createSquashFilesIntoChildPayload,
    createSquashFilesIntoParentPayload,
} from '../vscode/payloads/squash-files.payload';
import {
    createSquashRevisionIntoAncestorPayload,
    createSquashRevisionIntoParentPayload,
} from '../vscode/payloads/squash-revision.payload';
import {
    createSquashHunkIntoParentPayload,
    createSquashSelectionIntoParentPayload,
} from '../vscode/payloads/squash-selection.payload';
import {
    createWorkspaceOpenInCurrentWindowPayload,
    createWorkspaceOpenInNewWindowPayload,
} from '../vscode/payloads/workspace-open.payload';
import type { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { createMock } from './test-utils';

describe('vscode payloads', () => {
    describe('abandon payload', () => {
        it('extracts working copy when resource group is working copy', () => {
            const scmGroup = { id: 'jj.group.workingCopy', label: 'Working Copy', resourceStates: [] };
            const payload = createAbandonPayload([scmGroup]);
            expect(payload.revisions).toEqual(['@']);
        });

        it('extracts multiple revisions from args', () => {
            const payload = createAbandonPayload(['rev1', 'rev2']);
            expect(payload.revisions).toEqual(['rev1', 'rev2']);
        });

        it('falls back to selected revisions from scmProvider', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                getSelectedCommitIds: vi.fn().mockReturnValue(['sel1', 'sel2']),
            });
            const payload = createAbandonPayload([], scmProvider);
            expect(payload.revisions).toEqual(['sel1', 'sel2']);
        });
    });

    describe('absorb payload', () => {
        it('extracts fromRevision from commitId object', () => {
            const payload = createAbsorbPayload([{ commitId: 'c123' }]);
            expect(payload.fromRevision).toBe('c123');
        });
    });

    describe('bookmark advance payloads', () => {
        it('createAdvanceBookmarkPayload extracts revision', () => {
            const payload = createAdvanceBookmarkPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });

        it('createAdvanceBookmarkAndUploadPayload extracts revision', () => {
            const payload = createAdvanceBookmarkAndUploadPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('bookmark payload', () => {
        it('extracts revision and name', () => {
            const payload = createSetBookmarkPayload([{ commitId: 'rev1', name: 'bm1' }]);
            expect(payload.name).toBe('bm1');
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('commit payload', () => {
        it('extracts description from scmProvider input box', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                inputBoxValue: 'commit msg',
            });
            const payload = createCommitPayload([], scmProvider);
            expect(payload.description).toBe('commit msg');
        });

        it('createCommitPromptPayload extracts initialValue from scmProvider', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                inputBoxValue: 'prompt msg',
            });
            const payload = createCommitPromptPayload([], scmProvider);
            expect(payload.initialValue).toBe('prompt msg');
        });

        it('createCommitPromptPayload handles undefined scmProvider', () => {
            const payload = createCommitPromptPayload([], undefined);
            expect(payload.initialValue).toBeUndefined();
        });
    });

    describe('describe payload', () => {
        it('extracts description from string arg or scmProvider', () => {
            const payload = createSetDescriptionPayload(['my desc', 'rev1']);
            expect(payload.description).toBe('my desc');
            expect(payload.revision).toBe('rev1');
        });

        it('createDescribePromptPayload extracts initialValue from scmProvider', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                inputBoxValue: 'prompt describe',
            });
            const payload = createDescribePromptPayload([], scmProvider);
            expect(payload.initialValue).toBe('prompt describe');
        });

        it('createDescribePromptPayload handles undefined scmProvider', () => {
            const payload = createDescribePromptPayload([], undefined);
            expect(payload.initialValue).toBeUndefined();
        });
    });

    describe('details payload', () => {
        it('extracts revision from string arg', () => {
            const payload = createShowDetailsPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('duplicate payload', () => {
        it('extracts revision', () => {
            const payload = createDuplicatePayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('edit payload', () => {
        it('extracts revision', () => {
            const payload = createEditPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('merge editor payload', () => {
        it('extracts uri from resource state', () => {
            const uri = Uri.file('/test/file.txt');
            const resourceState = createMock<JjResourceState>({ resourceUri: uri });
            const payload = createOpenMergeEditorPayload([resourceState]);
            expect(payload.resourceStates[0].resourceUri.fsPath).toBe(uri.fsPath);
        });
    });

    describe('merge payload', () => {
        it('extracts revisions array', () => {
            const payload = createNewMergeChangePayload([{ revision: 'r1' }, { revision: 'r2' }]);
            expect(payload.revisions).toEqual(['r1', 'r2']);
        });
    });

    describe('multi diff payload', () => {
        it('extracts revision', () => {
            const payload = createShowMultiFileDiffPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('new payloads', () => {
        it('createNewPayload returns payload', () => {
            const payload = createNewPayload(['file.txt']);
            expect(payload).toBeDefined();
        });

        it('createNewAfterPayload extracts revision', () => {
            const payload = createNewAfterPayload([{ commitId: 'c1' }]);
            expect(payload.revisions).toEqual(['c1']);
        });

        it('createNewBeforePayload extracts revision', () => {
            const payload = createNewBeforePayload([{ commitId: 'c1' }]);
            expect(payload.revisions).toEqual(['c1']);
        });
    });

    describe('rebase payload', () => {
        it('extracts source and destination revisions', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                getSelectedCommitIds: vi.fn().mockReturnValue(['dest1']),
            });
            const payload = createRebaseOntoSelectedPayload([{ commitId: 'src1' }], scmProvider);
            expect(payload.sourceId).toBe('src1');
            expect(payload.destinations).toEqual(['dest1']);
        });
    });

    describe('restore payload', () => {
        it('extracts paths grouped by revision', () => {
            const uri = Uri.file('/path/to/file.txt');
            const payload = createRestorePayload([{ resourceUri: uri, revision: 'r1' }]);
            expect(payload.pathsByRevision.r1).toBeDefined();
        });
    });

    describe('compare all files with revision payload', () => {
        it('extracts revision', () => {
            const payload = createCompareAllFilesWithRevisionPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('squash files payloads', () => {
        it('createSquashFilesIntoParentPayload extracts paths and revision', () => {
            const uri = Uri.file('/test/file.txt');
            const payload = createSquashFilesIntoParentPayload([{ resourceUri: uri }, 'rev1']);
            expect(payload.paths).toEqual([uri.fsPath]);
            expect(payload.revision).toBe('rev1');
        });

        it('createSquashFilesIntoAncestorPayload extracts ancestorRevision from object arg', () => {
            const uri = Uri.file('/test/file.txt');
            const payload = createSquashFilesIntoAncestorPayload([
                { resourceUri: uri },
                { revision: 'srcRev', ancestorRevision: 'targetAncestor' },
            ]);
            expect(payload.revision).toBe('srcRev');
            expect(payload.ancestorRevision).toBe('targetAncestor');
        });

        it('createSquashFilesIntoAncestorPayload extracts ancestorRevision from multiple revision args', () => {
            const uri = Uri.file('/test/file.txt');
            const payload = createSquashFilesIntoAncestorPayload([{ resourceUri: uri }, 'srcRev', 'targetAncestor']);
            expect(payload.revision).toBe('srcRev');
            expect(payload.ancestorRevision).toBe('targetAncestor');
        });

        it('createSquashFilesIntoChildPayload extracts childRevision from object arg', () => {
            const uri = Uri.file('/test/file.txt');
            const payload = createSquashFilesIntoChildPayload([
                { resourceUri: uri },
                { revision: 'srcRev', childRevision: 'targetChild' },
            ]);
            expect(payload.revision).toBe('srcRev');
            expect(payload.childRevision).toBe('targetChild');
        });

        it('createSquashFilesIntoChildPayload extracts childRevision from multiple revision args', () => {
            const uri = Uri.file('/test/file.txt');
            const payload = createSquashFilesIntoChildPayload([{ resourceUri: uri }, 'srcRev', 'targetChild']);
            expect(payload.revision).toBe('srcRev');
            expect(payload.childRevision).toBe('targetChild');
        });
    });

    describe('squash revision payloads', () => {
        it('createSquashRevisionIntoParentPayload extracts targetParent from object arg', () => {
            const payload = createSquashRevisionIntoParentPayload([{ revision: 'rev1', targetParent: 'parent1' }]);
            expect(payload.revision).toBe('rev1');
            expect(payload.targetParent).toBe('parent1');
        });

        it('createSquashRevisionIntoParentPayload extracts targetParent from multiple revision args', () => {
            const payload = createSquashRevisionIntoParentPayload(['rev1', 'parent1']);
            expect(payload.revision).toBe('rev1');
            expect(payload.targetParent).toBe('parent1');
        });

        it('createSquashRevisionIntoAncestorPayload extracts ancestorRevision from object arg', () => {
            const payload = createSquashRevisionIntoAncestorPayload([{ revision: 'rev1', ancestorRevision: 'anc1' }]);
            expect(payload.revision).toBe('rev1');
            expect(payload.ancestorRevision).toBe('anc1');
        });

        it('createSquashRevisionIntoAncestorPayload extracts ancestorRevision from multiple revision args', () => {
            const payload = createSquashRevisionIntoAncestorPayload(['rev1', 'anc1']);
            expect(payload.revision).toBe('rev1');
            expect(payload.ancestorRevision).toBe('anc1');
        });
    });

    describe('squash selection payloads', () => {
        it('createSquashHunkIntoParentPayload extracts uri and ranges', () => {
            const uri = Uri.file('/test/file.txt');
            const changes = [
                {
                    originalStartLineNumber: 2,
                    originalEndLineNumber: 2,
                    modifiedStartLineNumber: 2,
                    modifiedEndLineNumber: 2,
                },
            ];
            const payload = createSquashHunkIntoParentPayload([uri, changes, 0]);
            expect(payload.uri?.fsPath).toBe(uri.fsPath);
            expect(payload.ranges).toEqual([{ startLine: 1, endLine: 1 }]);
        });

        it('createSquashSelectionIntoParentPayload extracts ranges from selections', () => {
            const uri = Uri.file('/test/file.txt');
            const editor = createMock<vscode.TextEditor>({
                document: createMock<vscode.TextDocument>({ uri }),
                selections: [
                    createMock<vscode.Selection>({
                        start: createMock<vscode.Position>({ line: 0 }),
                        end: createMock<vscode.Position>({ line: 2 }),
                    }),
                ],
            });
            const payload = createSquashSelectionIntoParentPayload(editor);
            expect(payload.uri?.fsPath).toBe(uri.fsPath);
            expect(payload.ranges).toEqual([{ startLine: 0, endLine: 2 }]);
        });
    });

    describe('workspace open payloads', () => {
        it('createWorkspaceOpenInCurrentWindowPayload extracts workspaceName', () => {
            const payload = createWorkspaceOpenInCurrentWindowPayload([{ workspaceName: 'ws1' }]);
            expect(payload.workspaceName).toBe('ws1');
        });

        it('createWorkspaceOpenInNewWindowPayload extracts workspaceName', () => {
            const payload = createWorkspaceOpenInNewWindowPayload([{ workspaceName: 'ws1' }]);
            expect(payload.workspaceName).toBe('ws1');
        });
    });
});
