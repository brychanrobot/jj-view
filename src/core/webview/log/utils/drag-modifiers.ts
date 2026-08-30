/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PressedKeysState {
    r: boolean;
    shift: boolean;
    s: boolean;
    d: boolean;
    m: boolean;
}

export type WebviewDragMessage =
    | { type: 'rebaseCommit'; payload: { sourceChangeId: string; targetChangeId: string; mode: 'source' | 'revision' } }
    | { type: 'squashCommit'; payload: { sourceChangeId: string; targetChangeId: string; mode: 'into' | 'onto' } }
    | { type: 'duplicateCommit'; payload: { sourceChangeId: string; targetChangeId?: string } }
    | { type: 'mergeCommit'; payload: { sourceChangeId: string; targetChangeId: string } };

export interface DragActionModifier {
    id: string;
    label: string;
    shortLabel?: string;
    description: string;
    badgeText: string;
    shortcutHint: string;
    accentColor: string;
    priority: number;
    matches: (keys: PressedKeysState) => boolean;
    buildMessagePayload: (sourceChangeId: string, targetChangeId?: string) => WebviewDragMessage;
}

export const REBASE_BRANCH_MODIFIER: DragActionModifier = {
    id: 'rebase-branch',
    label: 'Rebase Branch',
    shortLabel: 'Rebase Branch',
    description: 'Rebase branch (source & descendants)',
    badgeText: 'Rebase branch here',
    shortcutHint: 'Default',
    accentColor: 'var(--vscode-charts-blue)',
    priority: 0,
    matches: () => true,
    buildMessagePayload: (sourceChangeId, targetChangeId) => ({
        type: 'rebaseCommit',
        payload: { sourceChangeId, targetChangeId: targetChangeId || '', mode: 'source' },
    }),
};

export const REBASE_REVISION_MODIFIER: DragActionModifier = {
    id: 'rebase-revision',
    label: 'Rebase Revision Only',
    shortLabel: 'Rebase Rev',
    description: 'Rebase revision only',
    badgeText: 'Rebase revision here',
    shortcutHint: 'R',
    accentColor: 'var(--vscode-charts-orange)',
    priority: 10,
    matches: (keys) => keys.r,
    buildMessagePayload: (sourceChangeId, targetChangeId) => ({
        type: 'rebaseCommit',
        payload: { sourceChangeId, targetChangeId: targetChangeId || '', mode: 'revision' },
    }),
};

export const SQUASH_INTO_MODIFIER: DragActionModifier = {
    id: 'squash-into',
    label: 'Squash Into Target',
    shortLabel: 'Squash Into',
    description: 'Squash source commit into target',
    badgeText: 'Squash into target here',
    shortcutHint: 'S',
    accentColor: 'var(--vscode-charts-purple)',
    priority: 10,
    matches: (keys) => keys.s && !keys.shift,
    buildMessagePayload: (sourceChangeId, targetChangeId) => ({
        type: 'squashCommit',
        payload: { sourceChangeId, targetChangeId: targetChangeId || '', mode: 'into' },
    }),
};

export const SQUASH_ONTO_MODIFIER: DragActionModifier = {
    id: 'squash-onto',
    label: 'Squash Onto Target',
    shortLabel: 'Squash Onto',
    description: 'Squash source onto target (new commit on top of target)',
    badgeText: 'Squash onto target here',
    shortcutHint: 'Shift + S',
    accentColor: 'var(--vscode-charts-magenta)',
    priority: 20,
    matches: (keys) => keys.shift && keys.s,
    buildMessagePayload: (sourceChangeId, targetChangeId) => ({
        type: 'squashCommit',
        payload: { sourceChangeId, targetChangeId: targetChangeId || '', mode: 'onto' },
    }),
};

export const DUPLICATE_MODIFIER: DragActionModifier = {
    id: 'duplicate',
    label: 'Duplicate Onto Target',
    shortLabel: 'Duplicate',
    description: 'Duplicate source commit on top of target',
    badgeText: 'Duplicate onto target here',
    shortcutHint: 'D',
    accentColor: 'var(--vscode-charts-green)',
    priority: 10,
    matches: (keys) => keys.d,
    buildMessagePayload: (sourceChangeId, targetChangeId) => ({
        type: 'duplicateCommit',
        payload: targetChangeId ? { sourceChangeId, targetChangeId } : { sourceChangeId },
    }),
};

export const MERGE_MODIFIER: DragActionModifier = {
    id: 'merge',
    label: 'Merge Revisions',
    shortLabel: 'Merge',
    description: 'Create new revision merging source & target',
    badgeText: 'Merge with target here',
    shortcutHint: 'M',
    accentColor: 'var(--vscode-charts-yellow)',
    priority: 10,
    matches: (keys) => keys.m,
    buildMessagePayload: (sourceChangeId, targetChangeId) => ({
        type: 'mergeCommit',
        payload: { sourceChangeId, targetChangeId: targetChangeId || '' },
    }),
};

const UNSORTED_MODIFIERS: DragActionModifier[] = [
    SQUASH_ONTO_MODIFIER,
    SQUASH_INTO_MODIFIER,
    DUPLICATE_MODIFIER,
    MERGE_MODIFIER,
    REBASE_REVISION_MODIFIER,
    REBASE_BRANCH_MODIFIER,
];

export const BUILT_IN_MODIFIERS: DragActionModifier[] = [...UNSORTED_MODIFIERS].sort((a, b) => b.priority - a.priority);

export function resolveActiveModifier(keys: PressedKeysState): DragActionModifier {
    for (const modifier of BUILT_IN_MODIFIERS) {
        if (modifier.matches(keys)) {
            return modifier;
        }
    }
    return REBASE_BRANCH_MODIFIER;
}
