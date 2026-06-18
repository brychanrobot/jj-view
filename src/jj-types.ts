/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
    CodeForgeChangeInfo,
    CommitParent,
    JjBookmark,
    JjLogEntry,
    JjStatusEntry,
    JjWorkspace,
} from './jj-schemas';

export type { CodeForgeChangeInfo, CommitParent, JjBookmark, JjLogEntry, JjStatusEntry, JjWorkspace };

export type CommitAction = 'newChild' | 'edit' | 'squash' | 'abandon' | 'openCodeForge' | 'upload' | 'describe';

export const TOGGLEABLE_COMMIT_ACTIONS = ['newChild', 'edit', 'squash', 'abandon', 'describe'] as const;
export type ToggleableCommitAction = (typeof TOGGLEABLE_COMMIT_ACTIONS)[number];

export interface ActionPayload {
    changeId: string;
    isImmutable?: boolean;
    url?: string;
    multiSelect?: boolean;
    changeIdShortest?: string;
    isDivergent?: boolean;
    changeIdOffset?: number;
}

/** Payload for the initial webview load */
export interface WebviewPayload {
    commits?: JjLogEntry[];
    minChangeIdLength?: number;
    theme?: string;
    graphLabelAlignment?: string;
    hiddenActions?: CommitAction[];
    // Details fields
    changeId?: string;
    commitId?: string;
    description?: string;
    files?: JjStatusEntry[];
    isImmutable?: boolean;
    isEmpty?: boolean;
    isConflict?: boolean;
    author?: { name: string; email: string; timestamp: string };
    committer?: { name: string; email: string; timestamp: string };
    bookmarks?: JjBookmark[];
    tags?: string[];
    titleWidthRuler?: number;
    bodyWidthRuler?: number;
    formatDescriptionOnSave?: boolean;
}

export interface WebviewInitialData {
    view: 'graph' | 'details';
    payload?: WebviewPayload;
}
