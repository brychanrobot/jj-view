/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRemoteFileUrlPayload } from '../../../../src/core/commands/command-utils';
import type { RemoteFileUrlPayload } from '../../../../src/core/commands/remote-file-url';
import type { HostEnvironment, TextSelectionRange } from '../../../../src/core/host/host-environment';
import type { Uri } from '../../../../src/core/uri-utils';
import { toOneBasedLineRange } from '../../../../src/utils/remote-url-utils';
import type { EditorChatContextSelection } from '../../diff/chat-context-selection';
import type { TabEntry } from '../../tabs/tab-types';

/**
 * Resolves the primary document URI represented by a standalone Web editor tab,
 * preferring the deletions left pane when an editor selection originates there.
 */
export function resolveActiveTabDocumentUri(
    activeTab: TabEntry | undefined,
    editorSelection?: EditorChatContextSelection | null,
): Uri | undefined {
    if (!activeTab) {
        return undefined;
    }
    if (activeTab.view.type === 'diff') {
        if (editorSelection?.side === 'deletions' && activeTab.view.leftUri) {
            return activeTab.view.leftUri;
        }
        return activeTab.view.rightUri ?? activeTab.view.leftUri;
    }
    if (activeTab.view.type === 'file' || activeTab.view.type === 'merge') {
        return activeTab.view.uri;
    }
    if (activeTab.view.type === 'multi-diff') {
        if (editorSelection?.resourceUri) {
            return editorSelection.resourceUri;
        }
        const firstEntry = activeTab.view.files[0];
        return firstEntry ? (firstEntry.rightUri ?? firstEntry.leftUri) : undefined;
    }
    return undefined;
}

/**
 * Resolves 0-based active tab selections across gutter line selections and text/ShadowRoot selections.
 */
export function resolveActiveTabDocumentSelections(
    activeTabSelection: readonly TextSelectionRange[] | undefined,
    editorSelection?: EditorChatContextSelection | null,
): readonly TextSelectionRange[] | undefined {
    if (activeTabSelection && activeTabSelection.length > 0) {
        return activeTabSelection;
    }
    if (editorSelection?.startLine !== undefined) {
        const startLine = Math.max(0, editorSelection.startLine - 1);
        const endLine = Math.max(0, (editorSelection.endLine ?? editorSelection.startLine) - 1);
        return [{ startLine, endLine }];
    }
    return undefined;
}

/**
 * Enriches standalone `editor/context` menu payloads with active diff side URIs, multi-diff entry URIs,
 * file status (so deleted right panes resolve cleanly), and captured 1-based line ranges.
 */
export function enrichWebRemoteFilePayload(options: {
    commandId: string;
    payload: unknown;
    activeTab: TabEntry | undefined;
    editorSelection: EditorChatContextSelection | null;
    activeTabSelection: readonly TextSelectionRange[] | undefined;
}): unknown {
    const { commandId, payload, activeTab, editorSelection, activeTabSelection } = options;
    if (commandId !== 'jj-view.openFileOnRemote' && commandId !== 'jj-view.copyRemoteFileUrl') {
        return payload;
    }
    if (
        typeof payload !== 'object' ||
        payload === null ||
        !('menuId' in payload) ||
        payload.menuId !== 'editor/context'
    ) {
        return payload;
    }

    const baseUri = 'resourceUri' in payload ? payload.resourceUri : undefined;
    const baseFileStatus =
        'fileStatus' in payload && typeof payload.fileStatus === 'string' ? payload.fileStatus : undefined;
    let resourceUri: unknown = baseUri;
    let fileStatus = baseFileStatus;

    if (activeTab?.view.type === 'diff') {
        resourceUri = resolveActiveTabDocumentUri(activeTab, editorSelection) ?? resourceUri;
        fileStatus = fileStatus ?? activeTab.view.resourceState?.status;
    } else if (activeTab?.view.type === 'multi-diff') {
        resourceUri = resolveActiveTabDocumentUri(activeTab, editorSelection) ?? resourceUri;
        fileStatus = fileStatus ?? editorSelection?.fileStatus ?? activeTab.view.files[0]?.fileStatus;
    }

    const fallbackFilePath =
        !resourceUri && activeTab?.view.type === 'multi-diff' && editorSelection?.fsPath
            ? editorSelection.fsPath
            : undefined;
    const gutterSel = activeTabSelection?.[0];
    const lineRange =
        editorSelection?.startLine !== undefined
            ? { startLine: editorSelection.startLine, endLine: editorSelection.endLine ?? editorSelection.startLine }
            : gutterSel
              ? toOneBasedLineRange(gutterSel)
              : undefined;

    return {
        ...payload,
        ...(resourceUri ? { resourceUri } : {}),
        ...(fileStatus ? { fileStatus } : {}),
        ...(fallbackFilePath ? { filePath: fallbackFilePath } : {}),
        ...(lineRange ? { lineRange } : {}),
        skipActiveSelection: true,
    };
}

/**
 * Builds a `RemoteFileUrlPayload` for standalone web / shared host commands across
 * Command Palette, Pierre editor/diff context menus, SCM resource items, and Commit Details.
 */
export function createRemoteFileUrlPayload(
    args: unknown[] = [],
    hostEnvironment?: HostEnvironment,
): RemoteFileUrlPayload {
    const { hasExplicitSource, payload } = extractRemoteFileUrlPayload(args);
    if (hasExplicitSource) {
        return payload;
    }

    const activeUri = hostEnvironment?.documents?.getActiveDocumentUri?.();
    if (!activeUri) {
        return {};
    }

    const selections = hostEnvironment?.documents?.getActiveDocumentSelections?.();
    const lineRange = selections && selections.length > 0 ? toOneBasedLineRange(selections[0]) : undefined;
    return {
        fileUri: activeUri,
        lineRange,
    };
}
