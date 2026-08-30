/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JjStatusEntry } from '../core/jj-types';
import { createJjResourceState } from '../core/scm-resource-state';
import { Uri } from '../core/uri-utils';
import './vitest-utils';

describe('createJjResourceState', () => {
    const root = '/root';

    describe('Basic Fields and URI construction', () => {
        it('creates resource state with correct basic fields', () => {
            const entry: JjStatusEntry = {
                path: 'file.txt',
                status: 'modified',
            };
            const state = createJjResourceState(entry, 'rev123', root);

            expect(state.resourceUri.path).toBe('/file.txt');
            expect(state.revision).toBe('rev123');
            expect(state.leftUri?.path).toBe('/file.txt');
            expect(state.rightUri?.path).toBe('/file.txt');
        });

        it('uses oldPath as leftPath for renamed entries', () => {
            const entry: JjStatusEntry = {
                path: 'new-file.txt',
                status: 'renamed',
                oldPath: 'old-file.txt',
            };
            const state = createJjResourceState(entry, 'rev123', root);

            expect(state.leftUri?.path).toBe('/old-file.txt');
            expect(state.rightUri?.path).toBe('/new-file.txt');
        });

        it('uses oldPath as leftPath for copied entries', () => {
            const entry: JjStatusEntry = {
                path: 'new-file.txt',
                status: 'copied',
                oldPath: 'old-file.txt',
            };
            const state = createJjResourceState(entry, 'rev123', root);

            expect(state.leftUri?.path).toBe('/old-file.txt');
            expect(state.rightUri?.path).toBe('/new-file.txt');
        });

        it('uses jj-edit scheme for editable non-working-copy rightUri', () => {
            const entry: JjStatusEntry = {
                path: 'file.txt',
                status: 'modified',
            };
            const state = createJjResourceState(entry, 'rev123', root, {
                editable: true,
            });

            expect(state.rightUri?.scheme).toBe('jj-edit');
            expect(state.rightUri?.fragment).toContain('revision=rev123');
        });

        it('uses jj-view scheme for non-editable non-working-copy rightUri', () => {
            const entry: JjStatusEntry = {
                path: 'file.txt',
                status: 'modified',
            };
            const state = createJjResourceState(entry, 'rev123', root, {
                editable: false,
            });

            expect(state.rightUri?.scheme).toBe('jj-view');
            expect(state.rightUri?.fragment).toContain('side=right');
        });
    });

    describe('Working Copy Detection & Diff Title', () => {
        const entry: JjStatusEntry = { path: 'file.txt', status: 'modified' };

        it('detects working copy when revision is @', () => {
            const state = createJjResourceState(entry, '@', root);
            expect(state.diffTitle).toBe('file.txt (Working Copy)');
        });

        it('detects working copy when revision matches workingCopyChangeId', () => {
            const state = createJjResourceState(entry, 'commit-123', root, {
                workingCopyChangeId: 'commit-123',
            });
            expect(state.diffTitle).toBe('file.txt (Working Copy)');
        });

        it('does not detect working copy when revision differs from workingCopyChangeId', () => {
            const state = createJjResourceState(entry, 'commit-123', root, {
                workingCopyChangeId: 'commit-456',
            });
            expect(state.diffTitle).toBe('file.txt (commit-123)');
        });
    });

    describe('Command Routing', () => {
        const entry: JjStatusEntry = { path: 'file.txt', status: 'modified' };

        it('routes to jj-view.openMergeEditor when conflicted and in conflict group', () => {
            const conflictedEntry: JjStatusEntry = {
                path: 'file.txt',
                status: 'modified',
                conflicted: true,
            };
            const state = createJjResourceState(conflictedEntry, 'rev123', root, {
                inConflictGroup: true,
            });

            expect(state.command?.command).toBe('jj-view.openMergeEditor');
            expect(state.command?.title).toBe('Open 3-Way Merge');
            expect(state.command?.arguments).toEqual([{ resourceUri: state.resourceUri }]);
        });

        it('routes to vscode.diff when openDiffOnClick is true', () => {
            const state = createJjResourceState(entry, 'rev123', root, {
                openDiffOnClick: true,
            });

            expect(state.command?.command).toBe('vscode.diff');
            expect(state.command?.title).toBe('Open Changes');
            expect(state.command?.arguments).toEqual([state.leftUri, state.rightUri, state.diffTitle]);
        });

        it('routes to vscode.diff when entry is deleted even if openDiffOnClick is false', () => {
            const deletedEntry: JjStatusEntry = {
                path: 'file.txt',
                status: 'deleted',
            };
            const state = createJjResourceState(deletedEntry, 'rev123', root, {
                openDiffOnClick: false,
            });

            expect(state.command?.command).toBe('vscode.diff');
        });

        it('routes to vscode.open with query stripped if openDiffOnClick is false and not deleted', () => {
            const state = createJjResourceState(entry, 'rev123', root, {
                openDiffOnClick: false,
            });

            expect(state.command?.command).toBe('vscode.open');
            const targetUri = state.command?.arguments?.[0];
            expect(targetUri).toBeInstanceOf(Uri);
            if (targetUri instanceof Uri) {
                expect(targetUri.fsPath).toBeSameFsPath(path.resolve(root, 'file.txt'));
                expect(targetUri.query).toBe('');
            }
        });
    });

    describe('Decorations', () => {
        it('sets strikeThrough for deleted entries', () => {
            const entry: JjStatusEntry = { path: 'file.txt', status: 'deleted' };
            const state = createJjResourceState(entry, 'rev123', root);
            expect(state.decorations?.strikeThrough).toBe(true);
        });

        it('does not set strikeThrough for modified entries', () => {
            const entry: JjStatusEntry = { path: 'file.txt', status: 'modified' };
            const state = createJjResourceState(entry, 'rev123', root);
            expect(state.decorations?.strikeThrough).toBe(false);
        });
    });

    describe('Context Capabilities (ContextValue)', () => {
        const entry: JjStatusEntry = { path: 'file.txt', status: 'modified' };

        it('gives conflicted entries in conflict group restore and openMergeEditor flags, but no open or squash flags', () => {
            const conflictedEntry: JjStatusEntry = { ...entry, conflicted: true };
            const state = createJjResourceState(conflictedEntry, 'rev123', root, {
                inConflictGroup: true,
                squashable: true,
                multipleAncestors: true,
                hasChild: true,
            });

            const flags = state.contextValue?.split(' ') || [];
            expect(flags).toContain('jj.resource.allowRestore');
            expect(flags).toContain('jj.resource.allowOpenMergeEditor');
            expect(flags).not.toContain('jj.resource.allowOpen');
            expect(flags).not.toContain('jj.resource.allowSquashIntoParent');
            expect(flags).not.toContain('jj.resource.allowSquashIntoAncestor');
            expect(flags).not.toContain('jj.resource.allowSquashIntoChild');
        });

        it('gives conflicted entries not in conflict group normal restore, open, and squash flags', () => {
            const conflictedEntry: JjStatusEntry = { ...entry, conflicted: true };
            const state = createJjResourceState(conflictedEntry, 'rev123', root, {
                inConflictGroup: false,
                squashable: true,
                multipleAncestors: true,
                hasChild: true,
            });

            const flags = state.contextValue?.split(' ') || [];
            expect(flags).toContain('jj.resource.allowRestore');
            expect(flags).not.toContain('jj.resource.allowOpenMergeEditor');
            expect(flags).toContain('jj.resource.allowOpen');
            expect(flags).toContain('jj.resource.allowSquashIntoParent');
            expect(flags).toContain('jj.resource.allowSquashIntoAncestor');
            expect(flags).toContain('jj.resource.allowSquashIntoChild');
        });

        it('gives conflicted entries with omitted inConflictGroup normal restore, open, and squash flags', () => {
            const conflictedEntry: JjStatusEntry = { ...entry, conflicted: true };
            const state = createJjResourceState(conflictedEntry, 'rev123', root, {
                squashable: true,
                multipleAncestors: true,
                hasChild: true,
            });

            const flags = state.contextValue?.split(' ') || [];
            expect(flags).toContain('jj.resource.allowRestore');
            expect(flags).not.toContain('jj.resource.allowOpenMergeEditor');
            expect(flags).toContain('jj.resource.allowOpen');
            expect(flags).toContain('jj.resource.allowSquashIntoParent');
            expect(flags).toContain('jj.resource.allowSquashIntoAncestor');
            expect(flags).toContain('jj.resource.allowSquashIntoChild');
        });

        it('gives basic non-conflicted entries restore and open flags', () => {
            const state = createJjResourceState(entry, 'rev123', root);
            const flags = state.contextValue?.split(' ') || [];

            expect(flags).toContain('jj.resource.allowRestore');
            expect(flags).toContain('jj.resource.allowOpen');
            expect(flags).not.toContain('jj.resource.allowOpenMergeEditor');
        });

        it('sets squash-into-parent only when squashable is true', () => {
            const state = createJjResourceState(entry, 'rev123', root, {
                squashable: true,
            });
            const flags = state.contextValue?.split(' ') || [];

            expect(flags).toContain('jj.resource.allowSquashIntoParent');
            expect(flags).not.toContain('jj.resource.allowSquashIntoAncestor');
        });

        it('sets squash-into-ancestor only when both squashable and multipleAncestors are true', () => {
            const state = createJjResourceState(entry, 'rev123', root, {
                squashable: true,
                multipleAncestors: true,
            });
            const flags = state.contextValue?.split(' ') || [];

            expect(flags).toContain('jj.resource.allowSquashIntoParent');
            expect(flags).toContain('jj.resource.allowSquashIntoAncestor');
        });

        it('does not set squash-into-ancestor if multipleAncestors is true but squashable is false', () => {
            const state = createJjResourceState(entry, 'rev123', root, {
                squashable: false,
                multipleAncestors: true,
            });
            const flags = state.contextValue?.split(' ') || [];

            expect(flags).not.toContain('jj.resource.allowSquashIntoParent');
            expect(flags).not.toContain('jj.resource.allowSquashIntoAncestor');
        });

        describe('Squash Into Child capability', () => {
            it('sets squash-into-child for working copy (@) ONLY when hasChild is true', () => {
                const stateWithChild = createJjResourceState(entry, '@', root, { hasChild: true });
                const flagsWithChild = stateWithChild.contextValue?.split(' ') || [];
                expect(flagsWithChild).toContain('jj.resource.allowSquashIntoChild');

                const stateNoChild = createJjResourceState(entry, '@', root, { hasChild: false });
                const flagsNoChild = stateNoChild.contextValue?.split(' ') || [];
                expect(flagsNoChild).not.toContain('jj.resource.allowSquashIntoChild');
            });

            it('sets squash-into-child for matched workingCopyChangeId ONLY when hasChild is true', () => {
                const stateWithChild = createJjResourceState(entry, 'rev-wc', root, {
                    workingCopyChangeId: 'rev-wc',
                    hasChild: true,
                });
                const flagsWithChild = stateWithChild.contextValue?.split(' ') || [];
                expect(flagsWithChild).toContain('jj.resource.allowSquashIntoChild');

                const stateNoChild = createJjResourceState(entry, 'rev-wc', root, {
                    workingCopyChangeId: 'rev-wc',
                    hasChild: false,
                });
                const flagsNoChild = stateNoChild.contextValue?.split(' ') || [];
                expect(flagsNoChild).not.toContain('jj.resource.allowSquashIntoChild');
            });

            it('sets squash-into-child unconditionally for non-working copy revisions regardless of hasChild', () => {
                const state = createJjResourceState(entry, 'rev123', root, { hasChild: false });
                const flags = state.contextValue?.split(' ') || [];
                expect(flags).toContain('jj.resource.allowSquashIntoChild');
            });
        });
    });
});
