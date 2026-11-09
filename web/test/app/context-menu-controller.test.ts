/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { JjResourceState } from '../../../src/core/scm-resource-state';
import { Uri } from '../../../src/core/uri-utils';
import {
    ContextMenuController,
    reviveResourceState,
    unpackContextPayload,
} from '../../src/app/context-menu-controller.svelte';
import { ContextKeyService } from '../../src/menu/context-key-service';
import type { MenuRegistry } from '../../src/menu/menu-registry';
import { createMock } from '../test-mock';

describe('context-menu-controller', () => {
    it('revives raw resource state and unpacks context payloads', () => {
        const rawState = {
            resourceUri: { scheme: 'file', path: '/repo/a.txt', fsPath: '/repo/a.txt' },
            relativePath: 'a.txt',
            status: 'modified' as const,
        };

        const revived = reviveResourceState(rawState);
        expect(revived.resourceUri).toBeInstanceOf(Uri);
        expect(revived.relativePath).toBe('a.txt');

        const plainUnpacked = unpackContextPayload('simple string');
        expect(plainUnpacked).toBe('simple string');

        const payloadWithState = { resourceState: rawState };
        const unpackedState = unpackContextPayload(payloadWithState) as JjResourceState;
        expect(unpackedState.resourceUri).toBeInstanceOf(Uri);
        expect(unpackedState.resourceUri.fsPath).toBeSameFsPath('/repo/a.txt');

        const payloadWithUri = { resourceUri: { scheme: 'file', path: '/repo/b.txt', fsPath: '/repo/b.txt' } };
        const unpackedUri = unpackContextPayload(payloadWithUri) as { resourceUri: Uri };
        expect(unpackedUri.resourceUri).toBeInstanceOf(Uri);
        expect(unpackedUri.resourceUri.fsPath).toBeSameFsPath('/repo/b.txt');
    });

    it('captures coordinates and scoped menu actions on context menu events', () => {
        const mockMenuRegistry = createMock<MenuRegistry>({
            getContextActions: (_menuId, _context) => [
                {
                    id: 'group1',
                    groupName: 'group1',
                    items: [
                        {
                            id: 'jj-view.restore',
                            label: 'Restore',
                            title: 'Restore',
                            groupName: 'group1',
                            order: 1,
                            isInline: false,
                            command: 'jj-view.restore',
                        },
                    ],
                },
            ],
        });

        const rootContext = new ContextKeyService();

        const controller = new ContextMenuController({
            menuRegistry: mockMenuRegistry,
            rootContext,
            handleAction: async () => {},
            resolveActiveChatContextSelection: () => null,
        });

        // Simulate context menu mouse event
        const mockTarget = createMock<HTMLElement>({
            hasAttribute: (name: string) => name === 'data-vscode-context',
            getAttribute: (name: string) =>
                name === 'data-vscode-context'
                    ? JSON.stringify({
                          resourceUri: { scheme: 'file', path: '/repo/test.ts' },
                          menuId: 'scm/resourceState/context',
                      })
                    : null,
            parentElement: null,
        });

        let defaultPrevented = false;
        let propagationStopped = false;
        const mockEvent = createMock<MouseEvent>({
            target: mockTarget,
            clientX: 150,
            clientY: 220,
            preventDefault: () => {
                defaultPrevented = true;
            },
            stopPropagation: () => {
                propagationStopped = true;
            },
        });

        controller.handleWindowContextMenu(mockEvent);

        expect(defaultPrevented).toBe(true);
        expect(propagationStopped).toBe(true);
        expect(controller.state.visible).toBe(true);
        expect(controller.state.x).toBe(150);
        expect(controller.state.y).toBe(220);
        expect(controller.state.groups.length).toBe(1);

        // Dismiss context menu
        controller.closeContextMenu();
        expect(controller.state.visible).toBe(false);
        expect(controller.state.groups.length).toBe(0);
    });
});
