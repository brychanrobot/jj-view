/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { JjLogEntry } from '../../src/core/jj-types';
import type { ScmSnapshot } from '../../src/core/scm-model';
import { createJjResourceState } from '../../src/core/scm-resource-state';
import AppLayout from '../src/layout/AppLayout.svelte';
import SplitPane from '../src/layout/SplitPane.svelte';
import { ContextKeyService } from '../src/menu/context-key-service';
import { MenuRegistry } from '../src/menu/menu-registry';
import ScmHeader from '../src/scm/ScmHeader.svelte';
import ScmInputBox from '../src/scm/ScmInputBox.svelte';
import ScmPane from '../src/scm/ScmPane.svelte';
import ScmResourceGroup from '../src/scm/ScmResourceGroup.svelte';
import ScmResourceItem from '../src/scm/ScmResourceItem.svelte';
import { formatRepositoryDisplayNames, hasOnlyEmptyWorkingCopy } from '../src/scm/scm-repo-types';

function createMockLogEntry(overrides: Partial<JjLogEntry> = {}): JjLogEntry {
    return {
        change_id: 'qpvunstz1234',
        change_id_shortest: 'qpv',
        commit_id: 'abc123456789',
        description: 'feat: mock commit',
        author: {
            name: 'Test Author',
            email: 'test@example.com',
            timestamp: new Date().toISOString(),
        },
        committer: {
            name: 'Test Committer',
            email: 'test@example.com',
            timestamp: new Date().toISOString(),
        },
        parents: [],
        bookmarks: [],
        ...overrides,
    };
}

function createCleanSnapshot(overrides: Partial<ScmSnapshot> = {}): ScmSnapshot {
    return {
        currentEntry: createMockLogEntry({ changes: [], description: '' }),
        workingCopyChanges: [],
        workingCopyStatuses: new Map(),
        workingCopyLabel: 'Working Copy - qpv',
        workingCopyContextValue: 'jj.group.workingCopy',
        conflictedPaths: [],
        ancestors: [],
        parentMutable: false,
        hasChild: false,
        description: '',
        workingCopyCount: 0,
        ...overrides,
    };
}

describe('Web SCM Components (SSR & Rendering)', () => {
    const menuRegistry = new MenuRegistry();

    describe('hasOnlyEmptyWorkingCopy', () => {
        it('returns true when snapshot is undefined', () => {
            expect(hasOnlyEmptyWorkingCopy(undefined)).toBe(true);
        });

        it('returns true for a clean working copy with no conflicts, no ancestors, and empty description', () => {
            expect(hasOnlyEmptyWorkingCopy(createCleanSnapshot())).toBe(true);
            expect(hasOnlyEmptyWorkingCopy(createCleanSnapshot({ description: '   \n  ' }))).toBe(true);
        });

        it('returns false when workingCopyChanges is non-empty', () => {
            const snapshot = createCleanSnapshot({
                workingCopyChanges: [{ path: 'file.txt', status: 'modified' }],
            });
            expect(hasOnlyEmptyWorkingCopy(snapshot)).toBe(false);
        });

        it('returns false when conflictedPaths is non-empty', () => {
            const snapshot = createCleanSnapshot({
                conflictedPaths: ['conflict.txt'],
            });
            expect(hasOnlyEmptyWorkingCopy(snapshot)).toBe(false);
        });

        it('returns false when ancestors is non-empty', () => {
            const snapshot = createCleanSnapshot({
                ancestors: [
                    {
                        entry: createMockLogEntry({ change_id: 'parent123' }),
                        prefix: '@-1',
                        isMutable: true,
                        canSquash: false,
                        changes: [],
                        label: '@-1: parent',
                        contextValue: 'jj.group.ancestor',
                    },
                ],
            });
            expect(hasOnlyEmptyWorkingCopy(snapshot)).toBe(false);
        });

        it('returns false when description is non-empty', () => {
            const snapshot = createCleanSnapshot({
                description: 'wip: uncommitted commit message',
            });
            expect(hasOnlyEmptyWorkingCopy(snapshot)).toBe(false);
        });
    });

    describe('ScmHeader', () => {
        it('renders source control title and dynamic action buttons', () => {
            const context = new ContextKeyService();
            const result = render(ScmHeader, {
                props: {
                    title: 'SOURCE CONTROL',
                    menuRegistry,
                    context,
                    onAction: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('SOURCE CONTROL');
            expect(html).toContain('scm-title-action-jj-view.new');
            expect(html).toContain('scm-title-action-jj-view.setDescription');
            expect(html).toContain('scm-title-action-jj-view.commit');
            expect(html).toContain('scm-title-action-jj-view.refresh');
        });
    });

    describe('ScmInputBox', () => {
        it('renders commit description textarea and rulers', () => {
            const result = render(ScmInputBox, {
                props: {
                    value: 'feat: add new feature description',
                    onCommit: () => {},
                    onSetDescription: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('feat: add new feature description');
            expect(html).toContain('scm-input-textarea');
            expect(html).toContain('scm-input-container');
        });
    });

    describe('ScmResourceItem', () => {
        it('renders file name, directory, status badge, and hover actions', () => {
            const state = createJjResourceState({ path: 'src/web/test.ts', status: 'modified' }, '@', '/mock/repo', {
                squashable: true,
                openDiffOnClick: true,
            });
            const context = new ContextKeyService(undefined, {
                scmResourceState: state.contextValue,
                'jj.openDiffOnClick': true,
            });

            const result = render(ScmResourceItem, {
                props: {
                    resourceState: state,
                    context,
                    menuRegistry,
                    onOpen: () => {},
                    onAction: () => {},
                    onContextMenu: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('test.ts');
            expect(html).toContain('src/web');
            expect(html).toContain('status-modified');
            expect(html).toContain('M');
            expect(html).toContain('scm-resource-action-jj-view.openFile');
            expect(html).toContain('scm-resource-action-jj-view.restore');
            expect(html).toContain('scm-resource-action-jj-view.squashFilesIntoParent');
        });

        it('renders deleted file with strikethrough class', () => {
            const context = new ContextKeyService();
            const state = createJjResourceState({ path: 'deleted-file.txt', status: 'deleted' }, '@', '/mock/repo');

            const result = render(ScmResourceItem, {
                props: {
                    resourceState: state,
                    context,
                    menuRegistry,
                    onOpen: () => {},
                    onAction: () => {},
                    onContextMenu: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('deleted-file.txt');
            expect(html).toContain('status-deleted');
            expect(html).toContain('D');
            expect(html).toContain('deleted');
        });

        it('renders added file with A badge and status-added class', () => {
            const context = new ContextKeyService();
            const state = createJjResourceState({ path: 'new-file.txt', status: 'added' }, '@', '/mock/repo');

            const result = render(ScmResourceItem, {
                props: {
                    resourceState: state,
                    context,
                    menuRegistry,
                    onOpen: () => {},
                    onAction: () => {},
                    onContextMenu: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('new-file.txt');
            expect(html).toContain('status-added');
            expect(html).toContain('A');
        });
    });

    describe('ScmResourceGroup', () => {
        it('renders group label, count badge, and children items', () => {
            const rootContext = new ContextKeyService();
            const items = [
                createJjResourceState({ path: 'file1.txt', status: 'modified' }, '@', '/mock/repo'),
                createJjResourceState({ path: 'file2.txt', status: 'added' }, '@', '/mock/repo'),
            ];

            const result = render(ScmResourceGroup, {
                props: {
                    id: 'working-copy',
                    label: 'Working Copy - qpvunstz',
                    contextValue:
                        'jj.group.workingCopy jj.group.allowShowMultiFileDiff jj.group.allowAbandon jj.group.allowSquash',
                    items,
                    expanded: true,
                    rootContext,
                    menuRegistry,
                    onGroupAction: () => {},
                    onOpenResource: () => {},
                    onResourceAction: () => {},
                    onGroupContextMenu: () => {},
                    onResourceContextMenu: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('Working Copy - qpvunstz');
            expect(html).toContain('2');
            expect(html).toContain('file1.txt');
            expect(html).toContain('file2.txt');
            expect(html).toContain('scm-group-action-jj-view.showMultiFileDiff');
            expect(html).toContain('scm-group-action-jj-view.abandon');
            expect(html).toContain('scm-group-action-jj-view.squashRevisionIntoParent');
        });
    });

    describe('ScmPane Complete Integration', () => {
        it('renders complete SCM view hierarchy from ScmSnapshot', () => {
            const rootContext = new ContextKeyService();
            const snapshot: ScmSnapshot = {
                currentEntry: createMockLogEntry({
                    commit_id: 'abc123456789',
                    change_id: 'qpvunstz1234',
                    change_id_shortest: 'qpv',
                    description: 'feat: working copy changes',
                    is_current_working_copy: true,
                    is_immutable: false,
                    parents: [
                        {
                            commit_id: 'parent123456',
                            change_id: 'krsyowsw1234',
                            is_immutable: false,
                        },
                    ],
                    changes: [{ path: 'modified.ts', status: 'modified' }],
                }),
                workingCopyChanges: [{ path: 'modified.ts', status: 'modified' }],
                workingCopyStatuses: new Map([['modified.ts', { path: 'modified.ts', status: 'modified' }]]),
                workingCopyLabel: 'Working Copy - qpv',
                workingCopyContextValue:
                    'jj.group.workingCopy jj.group.allowShowMultiFileDiff jj.group.allowAbandon jj.group.allowSquash',
                conflictedPaths: ['conflict.ts'],
                ancestors: [
                    {
                        entry: createMockLogEntry({
                            commit_id: 'parent123456',
                            change_id: 'krsyowsw1234',
                            change_id_shortest: 'krs',
                            description: 'feat: parent commit\n\nBody',
                            is_current_working_copy: false,
                            is_immutable: false,
                            parents: [],
                            changes: [{ path: 'parent-file.ts', status: 'added' }],
                        }),
                        prefix: '@-1',
                        isMutable: true,
                        canSquash: false,
                        changes: [{ path: 'parent-file.ts', status: 'added' }],
                        label: '@-1: krs - feat: parent commit',
                        contextValue: 'jj.group.allowShowMultiFileDiff jj.group.allowShowDetails jj.group.allowEdit',
                    },
                ],
                parentMutable: true,
                hasChild: false,
                description: 'feat: working copy changes',
                workingCopyCount: 1,
            };

            const result = render(ScmPane, {
                props: {
                    snapshot,
                    workspaceRoot: '/mock/repo',
                    menuRegistry,
                    rootContext,
                    openDiffOnClick: true,
                    onOpenResource: () => {},
                    onCommit: () => {},
                    onSetDescription: () => {},
                    onAction: () => {},
                },
            });
            const html = result.body;

            // Header & description
            expect(html).toContain('SOURCE CONTROL');
            expect(html).toContain('feat: working copy changes');

            // Conflict group
            expect(html).toContain('Merge Conflicts');
            expect(html).toContain('conflict.ts');

            // Working copy group
            expect(html).toContain('Working Copy - qpv');
            expect(html).toContain('modified.ts');

            // Ancestor group
            expect(html).toContain('@-1: krs - feat: parent commit');
            expect(html).toContain('parent-file.ts');
        });

        it('deduplicates conflicted paths so they do not appear in working copy group', () => {
            const rootContext = new ContextKeyService();
            const snapshot: ScmSnapshot = {
                currentEntry: createMockLogEntry({
                    changes: [
                        { path: 'both-file.ts', status: 'modified' },
                        { path: 'clean-file.ts', status: 'modified' },
                    ],
                }),
                workingCopyChanges: [
                    { path: 'both-file.ts', status: 'modified' },
                    { path: 'clean-file.ts', status: 'modified' },
                ],
                workingCopyStatuses: new Map([
                    ['both-file.ts', { path: 'both-file.ts', status: 'modified' }],
                    ['clean-file.ts', { path: 'clean-file.ts', status: 'modified' }],
                ]),
                workingCopyLabel: 'Working Copy - qpv',
                workingCopyContextValue: 'jj.group.workingCopy',
                conflictedPaths: ['both-file.ts'],
                ancestors: [],
                parentMutable: true,
                hasChild: false,
                description: 'feat: test',
                workingCopyCount: 2,
            };

            const result = render(ScmPane, {
                props: {
                    snapshot,
                    workspaceRoot: '/mock/repo',
                    menuRegistry,
                    rootContext,
                    openDiffOnClick: true,
                    onOpenResource: () => {},
                    onCommit: () => {},
                    onSetDescription: () => {},
                    onAction: () => {},
                },
            });
            const html = result.body;

            // both-file.ts should appear in Merge Conflicts group
            expect(html).toContain('Merge Conflicts');
            expect(html).toContain('both-file.ts');
            // Working Copy group badge should show 1 item (clean-file.ts)
            expect(html).toContain('clean-file.ts');
        });

        it('disambiguates repository display names when basenames collide', () => {
            const names = formatRepositoryDisplayNames([
                '/work/chromium_base/src',
                '/work/ssr-support/src',
                '/work/jj-view',
            ]);
            expect(names.get('/work/chromium_base/src')).toEqual({ name: 'src', qualifier: 'chromium_base' });
            expect(names.get('/work/ssr-support/src')).toEqual({ name: 'src', qualifier: 'ssr-support' });
            expect(names.get('/work/jj-view')).toEqual({ name: 'jj-view' });
        });

        it('renders collapsible VS Code-style repository sections in multi-repo workspaces', () => {
            const rootContext = new ContextKeyService();
            const snapA: ScmSnapshot = {
                currentEntry: createMockLogEntry({
                    change_id: 'repoachange1',
                    change_id_shortest: 'rpa',
                    description: 'feat: repo A change',
                    changes: [{ path: 'alpha.ts', status: 'modified' }],
                }),
                workingCopyChanges: [{ path: 'alpha.ts', status: 'modified' }],
                workingCopyStatuses: new Map([['alpha.ts', { path: 'alpha.ts', status: 'modified' }]]),
                workingCopyLabel: 'Working Copy - rpa',
                workingCopyContextValue: 'jj.group.workingCopy',
                conflictedPaths: [],
                ancestors: [],
                parentMutable: true,
                hasChild: false,
                description: 'feat: repo A change',
                workingCopyCount: 1,
            };
            const snapB: ScmSnapshot = {
                currentEntry: createMockLogEntry({
                    change_id: 'repobchange2',
                    change_id_shortest: 'rpb',
                    description: 'fix: repo B change',
                    changes: [{ path: 'beta.ts', status: 'added' }],
                }),
                workingCopyChanges: [{ path: 'beta.ts', status: 'added' }],
                workingCopyStatuses: new Map([['beta.ts', { path: 'beta.ts', status: 'added' }]]),
                workingCopyLabel: 'Working Copy - rpb',
                workingCopyContextValue: 'jj.group.workingCopy',
                conflictedPaths: [],
                ancestors: [],
                parentMutable: false,
                hasChild: true,
                description: 'fix: repo B change',
                workingCopyCount: 1,
            };

            const result = render(ScmPane, {
                props: {
                    snapshot: snapA,
                    workspaceRoot: '/work/chromium_base/src',
                    focusedWorkspaceRoot: '/work/chromium_base/src',
                    repositories: [
                        {
                            workspaceRoot: '/work/chromium_base/src',
                            snapshot: snapA,
                        },
                        {
                            workspaceRoot: '/work/ssr-support/src',
                            snapshot: snapB,
                        },
                    ],
                    menuRegistry,
                    rootContext,
                    openDiffOnClick: true,
                    onOpenResource: () => {},
                    onCommit: () => {},
                    onSetDescription: () => {},
                    onAction: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('scm-repository-section');
            expect(html).toContain('chromium_base');
            expect(html).toContain('ssr-support');
            expect(html).toContain('scm-repository-focused-badge');
            expect(html).toContain('scm-title-action-jj-view.focusRepository');
            expect(html).toContain('feat: repo A change');
            expect(html).toContain('fix: repo B change');
            expect(html).toContain('alpha.ts');
            expect(html).toContain('beta.ts');
        });

        it('renders empty-only repositories as collapsed and dirty repositories as expanded in multi-repo workspaces', () => {
            const rootContext = new ContextKeyService();
            const cleanSnap = createCleanSnapshot({
                currentEntry: createMockLogEntry({
                    change_id: 'cleanrepochange',
                    change_id_shortest: 'cln',
                    description: '',
                    changes: [],
                }),
                workingCopyLabel: 'Working Copy - cln',
            });
            const dirtySnap: ScmSnapshot = {
                ...createCleanSnapshot(),
                currentEntry: createMockLogEntry({
                    change_id: 'dirtyrepochange',
                    change_id_shortest: 'drt',
                    description: 'feat: dirty repo change',
                    changes: [{ path: 'dirty.ts', status: 'modified' }],
                }),
                workingCopyChanges: [{ path: 'dirty.ts', status: 'modified' }],
                workingCopyStatuses: new Map([['dirty.ts', { path: 'dirty.ts', status: 'modified' }]]),
                workingCopyLabel: 'Working Copy - drt',
                workingCopyCount: 1,
            };

            const result = render(ScmPane, {
                props: {
                    snapshot: cleanSnap,
                    workspaceRoot: '/work/clean-repo',
                    focusedWorkspaceRoot: '/work/clean-repo',
                    repositories: [
                        {
                            workspaceRoot: '/work/clean-repo',
                            snapshot: cleanSnap,
                        },
                        {
                            workspaceRoot: '/work/dirty-repo',
                            snapshot: dirtySnap,
                        },
                    ],
                    menuRegistry,
                    rootContext,
                    openDiffOnClick: true,
                    onOpenResource: () => {},
                    onCommit: () => {},
                    onSetDescription: () => {},
                    onAction: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('clean-repo');
            expect(html).toContain('dirty-repo');

            // clean-repo is empty-only so it renders collapsed: aria-expanded="false" and its body/Working Copy group is omitted
            expect(html).toContain('aria-expanded="false"');
            expect(html).not.toContain('Working Copy - cln');

            // dirty-repo has changes so it renders expanded: aria-expanded="true" and contains its Working Copy group & file
            expect(html).toContain('aria-expanded="true"');
            expect(html).toContain('Working Copy - drt');
            expect(html).toContain('dirty.ts');
        });
    });

    describe('AppLayout & SplitPane', () => {
        it('renders AppLayout shell and main content', () => {
            const result = render(AppLayout, {
                props: {
                    repoPath: '/home/user/my-repo',
                },
            });
            const html = result.body;

            expect(html).toContain('app-shell');
            expect(html).toContain('app-main-content');
            expect(html).toContain('split-pane');
            expect(html).not.toContain('app-top-bar');
        });

        it('renders SplitPane resizable container', () => {
            const result = render(SplitPane, {
                props: {
                    size: 300,
                    onResize: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('split-container');
            expect(html).toContain('split-handle');
        });
    });
});
