/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ContextMenu from '../src/menu/ContextMenu.svelte';
import { ContextKeyService } from '../src/menu/context-key-service';
import { type ContextNodeLike, extractVsCodeContext } from '../src/menu/context-menu-utils';
import { MenuRegistry } from '../src/menu/menu-registry';

function createMockNode(attrs: Record<string, string>, parent: ContextNodeLike | null = null): ContextNodeLike {
    return {
        hasAttribute: (name: string) => name in attrs,
        getAttribute: (name: string) => attrs[name] ?? null,
        parentElement: parent,
    };
}

describe('Generalized Context Menu System', () => {
    describe('extractVsCodeContext', () => {
        it('returns null for null target', () => {
            expect(extractVsCodeContext(null)).toBeNull();
        });

        it('returns null when no ancestor has data-vscode-context', () => {
            const parent = createMockNode({});
            const child = createMockNode({}, parent);
            expect(extractVsCodeContext(child)).toBeNull();
        });

        it('extracts context from target element', () => {
            const el = createMockNode({
                'data-vscode-context': JSON.stringify({
                    webviewSection: 'commit',
                    commitId: 'rev123',
                }),
            });
            expect(extractVsCodeContext(el)).toEqual({
                webviewSection: 'commit',
                commitId: 'rev123',
            });
        });

        it('merges context hierarchically from outer ancestor to inner child', () => {
            const outer = createMockNode({
                'data-vscode-context': JSON.stringify({
                    webviewSection: 'commit',
                    commitId: 'rev123',
                    scope: 'parent',
                }),
            });

            const inner = createMockNode(
                {
                    'data-vscode-context': JSON.stringify({
                        webviewSection: 'jj.bookmark',
                        bookmarkName: 'main',
                    }),
                },
                outer,
            );

            const merged = extractVsCodeContext(inner);
            expect(merged).toEqual({
                webviewSection: 'jj.bookmark',
                commitId: 'rev123',
                scope: 'parent',
                bookmarkName: 'main',
            });
        });

        it('gracefully skips invalid or malformed JSON in ancestor chain', () => {
            const outer = createMockNode({
                'data-vscode-context': 'invalid-json{',
            });

            const inner = createMockNode(
                {
                    'data-vscode-context': JSON.stringify({
                        validKey: 'validValue',
                    }),
                },
                outer,
            );

            expect(extractVsCodeContext(inner)).toEqual({
                validKey: 'validValue',
            });
        });
    });

    describe('Webview Context Menu Contributed Actions', () => {
        const menuRegistry = new MenuRegistry();
        const rootContext = new ContextKeyService();

        it('returns commit context actions when webviewSection is commit', () => {
            const scopedContext = rootContext.createScoped({
                webviewSection: 'commit',
                isWorkingCopy: false,
                isImmutable: false,
                'jj.canNewAfter': true,
                'jj.canNewBefore': true,
                'jj.canEdit': true,
                'jj.canAbandon': true,
                'jj.canAbsorb': true,
                'jj.canSetBookmark': true,
            });

            const groups = menuRegistry.getContextActions('webview/context', scopedContext);
            expect(groups.length).toBeGreaterThan(0);

            const allCommands = groups.flatMap((g) => g.items.map((i) => i.command));
            expect(allCommands).toContain('jj-view.showMultiFileDiff');
            expect(allCommands).toContain('jj-view.newAfter');
            expect(allCommands).toContain('jj-view.newBefore');
            expect(allCommands).toContain('jj-view.edit');
            expect(allCommands).toContain('jj-view.abandon');
            expect(allCommands).toContain('jj-view.absorb');
            expect(allCommands).toContain('jj-view.setBookmark');
        });

        it('returns bookmark actions when webviewSection is jj.bookmark', () => {
            const scopedContext = rootContext.createScoped({
                webviewSection: 'jj.bookmark',
                bookmarkName: 'feature-1',
                isRemoteBookmark: false,
            });

            const groups = menuRegistry.getContextActions('webview/context', scopedContext);
            expect(groups.length).toBeGreaterThan(0);

            const allCommands = groups.flatMap((g) => g.items.map((i) => i.command));
            expect(allCommands).toContain('jj-view.deleteBookmark');
        });

        it('returns workspace actions when webviewSection is workspace', () => {
            const scopedContext = rootContext.createScoped({
                webviewSection: 'workspace',
                workspaceName: 'secondary',
            });

            const groups = menuRegistry.getContextActions('webview/context', scopedContext);
            expect(groups.length).toBeGreaterThan(0);

            const allCommands = groups.flatMap((g) => g.items.map((i) => i.command));
            expect(allCommands).toContain('jj-view.workspaceForget');
            expect(allCommands).toContain('jj-view.workspaceDelete');
        });

        it('returns SCM resource state actions when menuId is scm/resourceState/context', () => {
            const scopedContext = rootContext.createScoped({
                menuId: 'scm/resourceState/context',
                scmResourceState: 'jj.resource.workingCopy jj.resource.allowRestore jj.resource.allowOpen',
                'jj.openDiffOnClick': true,
            });

            const groups = menuRegistry.getContextActions('scm/resourceState/context', scopedContext);
            expect(groups.length).toBeGreaterThan(0);

            const allCommands = groups.flatMap((g) => g.items.map((i) => i.command));
            expect(allCommands).toContain('jj-view.restore');
            expect(allCommands).toContain('jj-view.openFile');
        });
    });

    describe('ContextMenu Component (SSR)', () => {
        it('renders groups, menu items, titles, and icons', () => {
            const groups = [
                {
                    groupName: 'navigation',
                    items: [
                        {
                            command: 'jj-view.showMultiFileDiff',
                            title: 'Show Multi-File Diff',
                            iconClass: 'codicon codicon-diff-multiple',
                        },
                        {
                            command: 'jj-view.newAfter',
                            title: 'New After',
                            iconClass: 'codicon codicon-add',
                        },
                    ],
                },
                {
                    groupName: 'danger',
                    items: [
                        {
                            command: 'jj-view.abandon',
                            title: 'Abandon',
                            iconClass: 'codicon codicon-trash',
                        },
                    ],
                },
            ];

            const result = render(ContextMenu, {
                props: {
                    x: 100,
                    y: 150,
                    groups,
                    onSelect: () => {},
                    onClose: () => {},
                },
            });
            const html = result.body;

            expect(html).toContain('data-testid="context-menu"');
            expect(html).toContain('Show Multi-File Diff');
            expect(html).toContain('New After');
            expect(html).toContain('Abandon');
            expect(html).toContain('menu-separator');
            expect(html).toContain('menu-item-jj-view.showMultiFileDiff');
            expect(html).toContain('menu-item-jj-view.newAfter');
            expect(html).toContain('menu-item-jj-view.abandon');
        });
    });
});
