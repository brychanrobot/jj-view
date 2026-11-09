/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { ScmContextValue } from '../../../src/core/jj-context-keys';
import type { JjLogEntry, JjStatusEntry } from '../../../src/core/jj-types';
import type { ScmAncestorEntry, ScmSnapshot } from '../../../src/core/scm-model';
import { createDiffUris, Uri } from '../../../src/core/uri-utils';
import { resolveScmResourceState } from '../../src/app/scm-resource-lookup';
import { createMock } from '../test-mock';

describe('resolveScmResourceState', () => {
    const workspaceRoot = '/repo';

    it('resolves working copy conflicted path', () => {
        const fileUri = Uri.file('/repo/conflicted.txt');
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: ['conflicted.txt'],
            workingCopyChanges: [],
            ancestors: [],
        });

        const state = resolveScmResourceState({
            rightUri: fileUri,
            snapshot,
            workspaceRoot,
        });

        expect(state).toBeDefined();
        expect(state?.relativePath).toBe('conflicted.txt');
        expect(state?.contextValue).toContain(ScmContextValue.ResourceAllowOpenMergeEditor);
        expect(state?.revision).toBe('@');
    });

    it('resolves working copy modified entry with squashable and parentMutable properties', () => {
        const wcEntry: JjStatusEntry = { path: 'src/app.ts', status: 'modified' };
        const uris = createDiffUris(wcEntry, '@', workspaceRoot);
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: [],
            workingCopyChanges: [wcEntry],
            parentMutable: true,
            hasChild: false,
            ancestors: [
                createMock<ScmAncestorEntry>({ entry: createMock<JjLogEntry>({ change_id: 'parent1' }) }),
                createMock<ScmAncestorEntry>({ entry: createMock<JjLogEntry>({ change_id: 'parent2' }) }),
            ],
        });

        const state = resolveScmResourceState({
            leftUri: uris.leftUri,
            rightUri: uris.rightUri,
            snapshot,
            workspaceRoot,
        });

        expect(state).toBeDefined();
        expect(state?.relativePath).toBe('src/app.ts');
        expect(state?.resourceUri.fsPath).toBeSameFsPath('/repo/src/app.ts');
        expect(state?.contextValue).toContain(ScmContextValue.ResourceAllowSquashIntoParent);
        expect(state?.contextValue).toContain(ScmContextValue.ResourceAllowSquashIntoAncestor);
    });

    it('resolves ancestor change with editable rightUri matching ancestor isMutable', () => {
        const ancestorEntry: JjStatusEntry = { path: 'lib/utils.ts', status: 'modified' };
        const changeId = 'rev456789';
        const uris = createDiffUris(ancestorEntry, changeId, workspaceRoot);

        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: [],
            workingCopyChanges: [],
            ancestors: [
                createMock<ScmAncestorEntry>({
                    entry: createMock<JjLogEntry>({ change_id: changeId }),
                    isMutable: true,
                    canSquash: true,
                    changes: [ancestorEntry],
                }),
            ],
        });

        const state = resolveScmResourceState({
            leftUri: uris.leftUri,
            rightUri: uris.rightUri,
            snapshot,
            workspaceRoot,
        });

        expect(state).toBeDefined();
        expect(state?.relativePath).toBe('lib/utils.ts');
        expect(state?.revision).toBe(changeId);
        expect(state?.rightUri?.scheme).toBe('jj-edit');
        expect(state?.contextValue).toContain(ScmContextValue.ResourceAllowSquashIntoParent);
    });

    it('honors isImmutable override when provided', () => {
        const ancestorEntry: JjStatusEntry = { path: 'lib/utils.ts', status: 'modified' };
        const changeId = 'revImmutable';
        const uris = createDiffUris(ancestorEntry, changeId, workspaceRoot);

        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: [],
            workingCopyChanges: [],
            ancestors: [
                createMock<ScmAncestorEntry>({
                    entry: createMock<JjLogEntry>({ change_id: changeId }),
                    isMutable: true,
                    canSquash: false,
                    changes: [ancestorEntry],
                }),
            ],
        });

        const state = resolveScmResourceState({
            leftUri: uris.leftUri,
            rightUri: uris.rightUri,
            snapshot,
            workspaceRoot,
            isImmutable: true,
        });

        expect(state).toBeDefined();
        expect(state?.rightUri?.scheme).toBe('jj-view');
    });

    it('resolves jj-edit uri scheme when revision is not in ancestors', () => {
        const editUri = Uri.parse('jj-edit:/repo/new-edit.txt');
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: [],
            workingCopyChanges: [],
            ancestors: [],
        });

        const state = resolveScmResourceState({
            rightUri: editUri,
            snapshot,
            workspaceRoot,
            explicitRevision: 'otherRev',
        });

        expect(state).toBeDefined();
        expect(state?.relativePath).toBe('new-edit.txt');
        expect(state?.rightUri?.scheme).toBe('jj-edit');
    });

    it('returns undefined when no matching change or ancestor is found', () => {
        const fileUri = Uri.file('/repo/unknown.txt');
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: [],
            workingCopyChanges: [],
            ancestors: [],
        });

        const state = resolveScmResourceState({
            rightUri: fileUri,
            snapshot,
            workspaceRoot,
        });

        expect(state).toBeUndefined();
    });

    it('strips Windows drive-prefixed workspace root regardless of drive letter casing', () => {
        const winRoot = 'C:\\Users\\Dev\\repo';
        const winFileUri = Uri.from({ scheme: 'file', path: '/c:/Users/Dev/repo/src/app.ts' });
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: ['src/app.ts'],
            workingCopyChanges: [],
            ancestors: [],
        });

        const state = resolveScmResourceState({
            rightUri: winFileUri,
            snapshot,
            workspaceRoot: winRoot,
        });

        expect(state).toBeDefined();
        expect(state?.relativePath).toBe('src/app.ts');
        expect(state?.leftUri?.path).toBe('/src/app.ts');
        expect(state?.contextValue).toContain(ScmContextValue.ResourceAllowOpenMergeEditor);
    });

    it('does not falsely match suffix-overlapping filenames without a path boundary', () => {
        const fileUri = Uri.file('/repo/src/my-app.ts');
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: ['app.ts'],
            workingCopyChanges: [{ path: 'app.ts', status: 'modified' }],
            ancestors: [],
        });

        const state = resolveScmResourceState({
            rightUri: fileUri,
            snapshot,
            workspaceRoot,
        });

        expect(state).toBeUndefined();
    });

    it('does not falsely match ancestors[0] when explicitRevision is empty string', () => {
        const fileUri = Uri.file('/repo/src/app.ts');
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: [],
            workingCopyChanges: [],
            ancestors: [
                createMock<ScmAncestorEntry>({
                    entry: createMock<JjLogEntry>({ change_id: 'parent1' }),
                    isMutable: true,
                    canSquash: true,
                    changes: [{ path: 'src/app.ts', status: 'modified' }],
                }),
            ],
        });

        const state = resolveScmResourceState({
            rightUri: fileUri,
            snapshot,
            workspaceRoot,
            explicitRevision: '',
            isWorkingCopyOverride: false,
        });

        expect(state).toBeUndefined();
    });

    it('preserves fallbackEntry status metadata when ancestor changes omit the file and on jj-edit fallback', () => {
        const deletedPath = 'src/removed.ts';
        const fallbackEntry: JjStatusEntry = { path: deletedPath, status: 'deleted' };
        const ancestorChangeId = 'rev789abc';
        const snapshot = createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({ change_id: 'wc123', bookmarks: [] }),
            conflictedPaths: [],
            workingCopyChanges: [],
            ancestors: [
                createMock<ScmAncestorEntry>({
                    entry: createMock<JjLogEntry>({ change_id: ancestorChangeId }),
                    isMutable: true,
                    canSquash: false,
                    changes: [],
                }),
            ],
        });

        const ancestorState = resolveScmResourceState({
            rightUri: Uri.file('/repo/src/removed.ts'),
            snapshot,
            workspaceRoot,
            explicitRevision: ancestorChangeId,
            isWorkingCopyOverride: false,
            fallbackEntry,
        });

        expect(ancestorState).toBeDefined();
        expect(ancestorState?.status).toBe('deleted');
        expect(ancestorState?.decorations?.strikeThrough).toBe(true);
        expect(ancestorState?.rightUri?.scheme).toBe('jj-view');

        const editUri = Uri.parse('jj-edit:/repo/src/removed.ts');
        const editFallbackState = resolveScmResourceState({
            rightUri: editUri,
            snapshot,
            workspaceRoot,
            explicitRevision: 'unknownRev',
            fallbackEntry,
        });

        expect(editFallbackState).toBeDefined();
        expect(editFallbackState?.status).toBe('deleted');
        expect(editFallbackState?.decorations?.strikeThrough).toBe(true);

        const renamedEntry: JjStatusEntry = {
            path: 'src/new-name.ts',
            oldPath: 'src/old-name.ts',
            status: 'renamed',
        };
        const renamedAncestorState = resolveScmResourceState({
            rightUri: Uri.file('/repo/src/new-name.ts'),
            snapshot,
            workspaceRoot,
            explicitRevision: ancestorChangeId,
            isWorkingCopyOverride: false,
            fallbackEntry: renamedEntry,
        });
        expect(renamedAncestorState).toBeDefined();
        expect(renamedAncestorState?.status).toBe('renamed');
        expect(renamedAncestorState?.leftUri?.path).toBe('/src/old-name.ts');
    });
});
