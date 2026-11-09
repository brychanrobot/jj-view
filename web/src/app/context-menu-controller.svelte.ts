/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { JjStatusEntry } from '../../../src/core/jj-types';
import type { JjResourceState, ResourceCommand, ResourceDecorations } from '../../../src/core/scm-resource-state';
import { Uri } from '../../../src/core/uri-utils';
import type { EditorChatContextSelection } from '../diff/chat-context-selection';
import type { ContextKeyService } from '../menu/context-key-service';
import { extractVsCodeContext } from '../menu/context-menu-utils';
import type { MenuRegistry } from '../menu/menu-registry';
import type { ResolvedMenuItemGroup } from '../menu/menu-types';

export interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    groups: readonly ResolvedMenuItemGroup[];
    payload?: unknown;
}

export function reviveResourceState(raw: Record<string, unknown>): JjResourceState {
    const rawUri = raw.resourceUri as Parameters<typeof Uri.revive>[0] | undefined;
    const resourceUri = rawUri ? Uri.revive(rawUri) : Uri.file('');
    const rawLeft = raw.leftUri as Parameters<typeof Uri.revive>[0] | undefined;
    const leftUri = rawLeft ? Uri.revive(rawLeft) : undefined;
    const rawRight = raw.rightUri as Parameters<typeof Uri.revive>[0] | undefined;
    const rightUri = rawRight ? Uri.revive(rawRight) : undefined;
    const command = raw.command as ResourceCommand | undefined;
    const decorations = raw.decorations as ResourceDecorations | undefined;
    const contextValue = typeof raw.contextValue === 'string' ? raw.contextValue : undefined;
    const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath : undefined;
    const diffTitle = typeof raw.diffTitle === 'string' ? raw.diffTitle : undefined;
    const revision = typeof raw.revision === 'string' ? raw.revision : '@';
    const status = raw.status as JjStatusEntry['status'] | undefined;

    return {
        resourceUri,
        relativePath,
        command,
        decorations,
        contextValue,
        leftUri,
        rightUri,
        diffTitle,
        revision,
        status,
    };
}

export function unpackContextPayload(payload: unknown): unknown {
    if (typeof payload !== 'object' || payload === null) {
        return payload;
    }
    const record = payload as Record<string, unknown>;
    if ('resourceState' in record && record.resourceState && typeof record.resourceState === 'object') {
        const raw = record.resourceState as Record<string, unknown>;
        return reviveResourceState(raw);
    }
    if ('resourceStates' in record && Array.isArray(record.resourceStates)) {
        return {
            ...record,
            resourceStates: record.resourceStates.map((s) =>
                typeof s === 'object' && s !== null ? reviveResourceState(s as Record<string, unknown>) : s,
            ),
        };
    }
    if ('resourceUri' in record && record.resourceUri && typeof record.resourceUri === 'object') {
        const rawUri = record.resourceUri as Parameters<typeof Uri.revive>[0];
        return {
            ...record,
            resourceUri: Uri.revive(rawUri),
        };
    }
    if ('rootUri' in record && record.rootUri && typeof record.rootUri === 'object') {
        const rawUri = record.rootUri as Parameters<typeof Uri.revive>[0];
        return {
            ...record,
            rootUri: Uri.revive(rawUri),
        };
    }
    return payload;
}

export interface ContextMenuControllerDeps {
    menuRegistry: MenuRegistry;
    rootContext: ContextKeyService;
    handleAction: (commandId: string, payload?: unknown) => Promise<void>;
    resolveActiveChatContextSelection: () => EditorChatContextSelection | null;
}

export class ContextMenuController {
    state = $state<ContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        groups: [],
        payload: undefined,
    });
    contextMenuSelectionSnapshot = $state<EditorChatContextSelection | null>(null);

    constructor(readonly deps: ContextMenuControllerDeps) {}

    closeContextMenu(): void {
        this.contextMenuSelectionSnapshot = null;
        this.state = {
            visible: false,
            x: 0,
            y: 0,
            groups: [],
            payload: undefined,
        };
    }

    handleWindowContextMenu(e: MouseEvent): void {
        const target = e.target as Element | null;
        const context = extractVsCodeContext(target);
        if (!context) {
            if (this.state.visible) {
                this.closeContextMenu();
            }
            return;
        }

        if (context.preventDefaultContextMenuItems) {
            e.preventDefault();
        }

        const menuId = typeof context.menuId === 'string' ? context.menuId : 'webview/context';
        if (menuId === 'editor/context') {
            this.contextMenuSelectionSnapshot = this.deps.resolveActiveChatContextSelection();
        } else {
            this.contextMenuSelectionSnapshot = null;
        }
        const scopedCtx = this.deps.rootContext.createScoped(context);
        const groups = this.deps.menuRegistry.getContextActions(menuId, scopedCtx);

        if (groups.length === 0) {
            if (this.state.visible) {
                this.closeContextMenu();
            }
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        this.state = {
            visible: true,
            x: e.clientX,
            y: e.clientY,
            groups,
            payload: context,
        };
    }
}
