/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
    BUILT_IN_MODIFIERS,
    type PressedKeysState,
    resolveActiveModifier,
    SQUASH_ONTO_MODIFIER,
} from '../webview/utils/drag-modifiers';

describe('DragModifierFramework', () => {
    const emptyKeys: PressedKeysState = {
        r: false,
        shift: false,
        s: false,
        d: false,
        m: false,
    };

    it('contains all 6 built-in modifiers in registry', () => {
        expect(BUILT_IN_MODIFIERS.length).toBe(6);
    });

    it('resolves Rebase Branch by default when no keys are pressed', () => {
        const modifier = resolveActiveModifier(emptyKeys);
        expect(modifier.id).toBe('rebase-branch');
        expect(modifier.label).toBe('Rebase Branch');
        expect(modifier.description).toBe('Rebase branch (source & descendants)');
        expect(modifier.badgeText).toBe('Rebase branch here');
        expect(modifier.shortcutHint).toBe('Default');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'rebaseCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'source' },
        });
    });

    it('resolves Rebase Revision when R is pressed', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, r: true });
        expect(modifier.id).toBe('rebase-revision');
        expect(modifier.label).toBe('Rebase Revision Only');
        expect(modifier.description).toBe('Rebase revision only');
        expect(modifier.badgeText).toBe('Rebase revision here');
        expect(modifier.shortcutHint).toBe('R');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'rebaseCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'revision' },
        });
    });

    it('resolves Squash Into when S is pressed without Shift', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, s: true });
        expect(modifier.id).toBe('squash-into');
        expect(modifier.label).toBe('Squash Into Target');
        expect(modifier.description).toBe('Squash source commit into target');
        expect(modifier.badgeText).toBe('Squash into target here');
        expect(modifier.shortcutHint).toBe('S');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'squashCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'into' },
        });
    });

    it('resolves Squash Onto when Shift+S is pressed', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, shift: true, s: true });
        expect(modifier.id).toBe('squash-onto');
        expect(modifier.label).toBe('Squash Onto Target');
        expect(modifier.description).toBe('Squash source onto target (new commit on top of target)');
        expect(modifier.badgeText).toBe('Squash onto target here');
        expect(modifier.shortcutHint).toBe('Shift + S');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'squashCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'onto' },
        });
    });

    it('resolves Duplicate when D is pressed', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, d: true });
        expect(modifier.id).toBe('duplicate');
        expect(modifier.label).toBe('Duplicate Onto Target');
        expect(modifier.description).toBe('Duplicate source commit on top of target');
        expect(modifier.badgeText).toBe('Duplicate onto target here');
        expect(modifier.shortcutHint).toBe('D');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'duplicateCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2' },
        });
    });

    it('resolves Merge Revision when M is pressed', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, m: true });
        expect(modifier.id).toBe('merge');
        expect(modifier.label).toBe('Merge Revisions');
        expect(modifier.description).toBe('Create new revision merging source & target');
        expect(modifier.badgeText).toBe('Merge with target here');
        expect(modifier.shortcutHint).toBe('M');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'mergeCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2' },
        });
    });

    it('prioritizes Shift+S over S alone when both shift and s are true', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, shift: true, s: true });
        expect(modifier.id).toBe(SQUASH_ONTO_MODIFIER.id);
    });

    it('uses standard VS Code theme token variable for Squash Onto accent color', () => {
        expect(SQUASH_ONTO_MODIFIER.accentColor).toBe('var(--vscode-charts-magenta)');
    });

    it('pre-sorts BUILT_IN_MODIFIERS by priority in descending order', () => {
        const priorities = BUILT_IN_MODIFIERS.map((m) => m.priority);
        const isSorted = priorities.every((p, i) => i === 0 || p <= priorities[i - 1]);
        expect(isSorted).toBe(true);
    });
});
