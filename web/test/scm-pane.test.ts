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

describe('Web SCM Components (SSR & Rendering)', () => {
    const menuRegistry = new MenuRegistry();

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
                    initialSize: 300,
                },
            });
            const html = result.body;

            expect(html).toContain('split-container');
            expect(html).toContain('split-handle');
        });
    });
});
