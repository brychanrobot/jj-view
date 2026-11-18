/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { JjLogEntry } from '../core/jj-types';
import type { ScmModel, ScmSnapshot } from '../core/scm-model';
import type { JjResourceState } from '../core/scm-resource-state';
import { Uri } from '../core/uri-utils';
import { createAbandonPayload } from '../vscode/payloads/abandon.payload';
import { createAbsorbPayload } from '../vscode/payloads/absorb.payload';
import { createSetBookmarkPayload } from '../vscode/payloads/bookmark.payload';
import { createAdvanceBookmarkPayload } from '../vscode/payloads/bookmark-advance.payload';
import { createAdvanceBookmarkAndUploadPayload } from '../vscode/payloads/bookmark-advance-upload.payload';
import { createCommitPayload, createCommitPromptPayload } from '../vscode/payloads/commit.payload';
import { createCompareAllFilesWithRevisionPayload } from '../vscode/payloads/compare-all-files-with-revision.payload';
import { createCompareWithUploadedPayload } from '../vscode/payloads/compare-with-uploaded.payload';
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
import { createPickChangePayload } from '../vscode/payloads/pick-change.payload';
import { createRebaseOntoSelectedPayload } from '../vscode/payloads/rebase.payload';
import { createRestorePayload } from '../vscode/payloads/restore.payload';
import { createRestoreFileFromRevisionPayload } from '../vscode/payloads/restore-file-from-revision.payload';
import { createSimplifyParentsPayload } from '../vscode/payloads/simplify-parents.payload';
import { createSplitFilesPayload } from '../vscode/payloads/split-files.payload';
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
import { createUploadPayload, createUploadStackPayload } from '../vscode/payloads/upload.payload';
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

    describe('simplify parents payload', () => {
        it('extracts working copy when resource group is working copy', () => {
            const scmGroup = { id: 'jj.group.workingCopy', label: 'Working Copy', resourceStates: [] };
            const payload = createSimplifyParentsPayload([scmGroup]);
            expect(payload.revisions).toEqual(['@']);
        });

        it('extracts single clicked commit when not part of selection', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                getSelectedCommitIds: vi.fn().mockReturnValue(['sel1', 'sel2']),
            });
            const payload = createSimplifyParentsPayload([{ changeId: 'other1' }], scmProvider);
            expect(payload.revisions).toEqual(['other1']);
        });

        it('expands clicked commit to selection when clicked commit is selected', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                getSelectedCommitIds: vi.fn().mockReturnValue(['sel1', 'sel2']),
            });
            const payload = createSimplifyParentsPayload([{ changeId: 'sel1' }], scmProvider);
            expect(payload.revisions).toEqual(['sel1', 'sel2']);
        });

        it('extracts multiple revisions from args', () => {
            const payload = createSimplifyParentsPayload(['rev1', 'rev2']);
            expect(payload.revisions).toEqual(['rev1', 'rev2']);
        });

        it('falls back to selected revisions from scmProvider when args are empty', () => {
            const scmProvider = createMock<VsCodeScmProvider>({
                getSelectedCommitIds: vi.fn().mockReturnValue(['sel1', 'sel2']),
            });
            const payload = createSimplifyParentsPayload([], scmProvider);
            expect(payload.revisions).toEqual(['sel1', 'sel2']);
        });

        it('returns empty revisions when args and selection are empty', () => {
            const payload = createSimplifyParentsPayload([]);
            expect(payload.revisions).toEqual([]);
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

        it('returns undefined revision when invoked without arguments', () => {
            const payload = createShowDetailsPayload([]);
            expect(payload).toEqual({ revision: undefined });
        });

        it('resolves empty ancestor group revision via scmProvider snapshot', () => {
            const emptyAncestorGroup = { id: 'ancestor-0', resourceStates: [] };
            const scmProvider = createMock<VsCodeScmProvider>({
                scmModel: createMock<ScmModel>({
                    snapshot: createMock<ScmSnapshot>({
                        ancestors: [
                            {
                                entry: createMock<JjLogEntry>({ change_id: 'parent-rev-id' }),
                                prefix: '@-1',
                                isMutable: true,
                                canSquash: false,
                                changes: [],
                                label: '@-1',
                                contextValue: 'jj.group.allowShowDetails',
                            },
                        ],
                    }),
                }),
            });

            const payload = createShowDetailsPayload([emptyAncestorGroup], scmProvider);
            expect(payload).toEqual({ revision: 'parent-rev-id' });
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
            expect(payload.resourceStates[0].resourceUri.fsPath).toBeSameFsPath(uri.fsPath);
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

    describe('pick change payload', () => {
        it('extracts valid revset string from first argument object', () => {
            expect(createPickChangePayload([{ revset: 'mutable()' }])).toEqual({ revset: 'mutable()' });
        });

        it('returns empty payload for missing, null, array, or non-object args', () => {
            expect(createPickChangePayload([])).toEqual({});
            expect(createPickChangePayload([undefined])).toEqual({});
            expect(createPickChangePayload([null])).toEqual({});
            expect(createPickChangePayload([['mutable()']])).toEqual({});
            expect(createPickChangePayload(['mutable()'])).toEqual({});
        });

        it('ignores non-string revset fields', () => {
            expect(createPickChangePayload([{ revset: 123 }])).toEqual({});
            expect(createPickChangePayload([{ revset: true }])).toEqual({});
            expect(createPickChangePayload([{ revset: {} }])).toEqual({});
            expect(createPickChangePayload([{ revset: null }])).toEqual({});
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

    describe('restore file from revision payload', () => {
        it('extracts fileUri and optional revision from args', () => {
            const uri = Uri.file('/path/to/file.txt');
            const directUriPayload = createRestoreFileFromRevisionPayload([uri]);
            expect(directUriPayload.fileUri?.fsPath).toBeSameFsPath(uri.fsPath);
            expect(directUriPayload.revision).toBeUndefined();

            const objPayload = createRestoreFileFromRevisionPayload([{ resourceUri: uri, revision: 'main' }]);
            expect(objPayload.fileUri?.fsPath).toBeSameFsPath(uri.fsPath);
            expect(objPayload.revision).toBe('main');
        });

        it('falls back to active tab modified URI before activeTextEditor when invoked without args', () => {
            const activeFileUri = Uri.file('/path/to/active-editor.txt');
            const leftDiffUri = Uri.parse('jj-view:///path/to/diff-target.txt?jj-revision=@-');
            const rightDiffUri = Uri.file('/path/to/diff-target.txt');
            const tabGroup = vscode.window.tabGroups.activeTabGroup as { activeTab?: vscode.Tab };
            const prevTab = tabGroup.activeTab;
            const prevEditor = vscode.window.activeTextEditor;

            try {
                tabGroup.activeTab = undefined;
                vscode.window.activeTextEditor = createMock<vscode.TextEditor>({
                    document: createMock<vscode.TextDocument>({ uri: activeFileUri }),
                });

                const editorFallback = createRestoreFileFromRevisionPayload([]);
                expect(editorFallback.fileUri?.fsPath).toBeSameFsPath(activeFileUri.fsPath);
                expect(editorFallback.revision).toBeUndefined();

                vscode.window.activeTextEditor = createMock<vscode.TextEditor>({
                    document: createMock<vscode.TextDocument>({ uri: leftDiffUri }),
                });
                tabGroup.activeTab = createMock<vscode.Tab>({
                    input: new vscode.TabInputTextDiff(leftDiffUri, rightDiffUri),
                });

                const diffTabFallback = createRestoreFileFromRevisionPayload([]);
                expect(diffTabFallback.fileUri?.scheme).toBe('file');
                expect(diffTabFallback.fileUri?.fsPath).toBeSameFsPath(rightDiffUri.fsPath);
            } finally {
                tabGroup.activeTab = prevTab;
                vscode.window.activeTextEditor = prevEditor;
            }
        });
    });

    describe('compare all files with revision payload', () => {
        it('extracts revision', () => {
            const payload = createCompareAllFilesWithRevisionPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
        });
    });

    describe('compare with uploaded payload', () => {
        it('extracts revision from arguments', () => {
            const payload = createCompareWithUploadedPayload(['rev123']);
            expect(payload.revision).toBe('rev123');
        });

        it('defaults to working copy @ when no argument is passed', () => {
            const payload = createCompareWithUploadedPayload([]);
            expect(payload.revision).toBe('@');
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

    describe('split files payloads', () => {
        it('createSplitFilesPayload extracts single and multi-selected SCM resource states', () => {
            const uri1 = Uri.file('/test/a.txt');
            const uri2 = Uri.file('/test/b.txt');
            const clicked = { resourceUri: uri1, revision: 'rev1' };
            const selected = [clicked, { resourceUri: uri2, revision: 'rev1' }];

            const payload = createSplitFilesPayload([clicked, selected]);
            expect(payload.paths).toEqual([uri1.fsPath, uri2.fsPath]);
            expect(payload.revision).toBe('rev1');
        });

        it('createSplitFilesPayload extracts explicit paths and revision object payloads', () => {
            const payload = createSplitFilesPayload([{ paths: ['a.txt', 'b.txt', 'a.txt'], revision: 'rev42' }]);
            expect(payload.paths).toEqual(['a.txt', 'b.txt']);
            expect(payload.revision).toBe('rev42');
        });

        it('createSplitFilesPayload defaults revision to @ when omitted', () => {
            const payload = createSplitFilesPayload([{ paths: ['a.txt'] }]);
            expect(payload.paths).toEqual(['a.txt']);
            expect(payload.revision).toBe('@');
        });

        it('createSplitFilesPayload rejects mixed-revision SCM resource states including same path across revisions', () => {
            const wcUri = Uri.file('/test/shared.txt');
            const ancestorUri = Uri.from({
                scheme: 'jj-edit',
                path: '/shared.txt',
                fragment: 'root=/test&jj-revision=rev-ancestor&revision=rev-ancestor',
            });
            const clicked = { resourceUri: wcUri, revision: '@' };
            const selected = [clicked, { resourceUri: ancestorUri, revision: 'rev-ancestor' }];

            const payload = createSplitFilesPayload([clicked, selected]);
            expect(payload.paths).toEqual([]);
            expect(payload.validationError).toContain('multiple revisions');
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

        it('resolves empty ancestor resource group via scmProvider snapshot instead of defaulting to @', () => {
            const emptyAncestorGroup = { id: 'ancestor-0', label: 'Parent', resourceStates: [] };
            const scmProvider = createMock<VsCodeScmProvider>({
                scmModel: createMock<VsCodeScmProvider['scmModel']>({
                    snapshot: createMock<NonNullable<VsCodeScmProvider['scmModel']['snapshot']>>({
                        ancestors: [
                            {
                                entry: {
                                    change_id: 'parentchangeid',
                                    commit_id: 'parentcommitid',
                                    description: 'Parent',
                                    author: { name: 'A', email: 'a@a.com', timestamp: '' },
                                    committer: { name: 'A', email: 'a@a.com', timestamp: '' },
                                    parents: [],
                                    bookmarks: [],
                                },
                                prefix: 'Parent',
                                isMutable: true,
                                canSquash: true,
                                changes: [],
                                label: 'Parent: parentch',
                                contextValue: 'jj.group.allowSquash',
                            },
                        ],
                    }),
                }),
            });

            expect(createSquashRevisionIntoParentPayload([emptyAncestorGroup], scmProvider)).toEqual({
                revision: 'parentchangeid',
                targetParent: undefined,
            });
            expect(createSquashRevisionIntoAncestorPayload([emptyAncestorGroup], scmProvider)).toEqual({
                revision: 'parentchangeid',
                ancestorRevision: undefined,
            });
            expect(() => createSquashRevisionIntoParentPayload([emptyAncestorGroup])).toThrow(
                'Could not resolve revision for resource group ancestor-0',
            );
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
            expect(payload.uri?.fsPath).toBeSameFsPath(uri.fsPath);
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
            expect(payload.uri?.fsPath).toBeSameFsPath(uri.fsPath);
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

    describe('upload payloads', () => {
        it('createUploadPayload defaults to single mode for context menu / standard invocations', () => {
            const payload = createUploadPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
            expect(payload.mode).toBe('single');

            const payloadWithChangeIdOnly = createUploadPayload([{ changeId: 'rev1' }]);
            expect(payloadWithChangeIdOnly.revision).toBe('rev1');
            expect(payloadWithChangeIdOnly.mode).toBe('single');

            const payloadWithBookmark = createUploadPayload([{ bookmarkName: 'my-feature' }]);
            expect(payloadWithBookmark.revision).toBe('my-feature');
            expect(payloadWithBookmark.mode).toBe('single');
        });

        it('createUploadPayload uses auto mode when invoked from webview cloud button', () => {
            const payloadWithExplicitAuto = createUploadPayload([{ mode: 'auto', changeId: 'rev1' }]);
            expect(payloadWithExplicitAuto.revision).toBe('rev1');
            expect(payloadWithExplicitAuto.mode).toBe('auto');
        });

        it('createUploadPayload handles empty arguments (Command Palette)', () => {
            const payload = createUploadPayload([]);
            expect(payload.revision).toBeUndefined();
            expect(payload.mode).toBe('single');
        });

        it('createUploadPayload preserves explicit mode', () => {
            const payload = createUploadPayload([{ changeId: 'rev1', mode: 'stack' }]);
            expect(payload.revision).toBe('rev1');
            expect(payload.mode).toBe('stack');
        });

        it('createUploadStackPayload sets stack mode', () => {
            const payload = createUploadStackPayload(['rev1']);
            expect(payload.revision).toBe('rev1');
            expect(payload.mode).toBe('stack');

            const payloadEmpty = createUploadStackPayload([]);
            expect(payloadEmpty.revision).toBeUndefined();
            expect(payloadEmpty.mode).toBe('stack');
        });
    });
});
