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
} from '../core/webview/log/utils/drag-modifiers';

describe('DragModifierFramework', () => {
    const emptyKeys: PressedKeysState = {
        r: false,
        shift: false,
        s: false,
        d: false,
        m: false,
        a: false,
        b: false,
    };

    it('contains all 10 built-in modifiers in registry', () => {
        expect(BUILT_IN_MODIFIERS.length).toBe(10);
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

    it('resolves Insert Revision After when A is pressed without Shift', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, a: true });
        expect(modifier.id).toBe('insert-after-revision');
        expect(modifier.label).toBe('Insert Revision After');
        expect(modifier.shortcutHint).toBe('A');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'rebaseCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'revision', placement: 'after' },
        });
    });

    it('resolves Insert Branch After when Shift+A is pressed', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, shift: true, a: true });
        expect(modifier.id).toBe('insert-after-branch');
        expect(modifier.label).toBe('Insert Branch After');
        expect(modifier.shortcutHint).toBe('Shift + A');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'rebaseCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'source', placement: 'after' },
        });
    });

    it('resolves Insert Revision Before when B is pressed without Shift', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, b: true });
        expect(modifier.id).toBe('insert-before-revision');
        expect(modifier.label).toBe('Insert Revision Before');
        expect(modifier.shortcutHint).toBe('B');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'rebaseCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'revision', placement: 'before' },
        });
    });

    it('resolves Insert Branch Before when Shift+B is pressed', () => {
        const modifier = resolveActiveModifier({ ...emptyKeys, shift: true, b: true });
        expect(modifier.id).toBe('insert-before-branch');
        expect(modifier.label).toBe('Insert Branch Before');
        expect(modifier.shortcutHint).toBe('Shift + B');
        expect(modifier.buildMessagePayload('c1', 'c2')).toEqual({
            type: 'rebaseCommit',
            payload: { sourceChangeId: 'c1', targetChangeId: 'c2', mode: 'source', placement: 'before' },
        });
    });

    it('resolves deterministic modifier when conflicting keys of equal priority are pressed', () => {
        // Both A and B are pressed without shift (both priority 10)
        // Deterministically resolves to insert-after-revision based on registry definition order
        const abModifier = resolveActiveModifier({ ...emptyKeys, a: true, b: true });
        expect(abModifier.id).toBe('insert-after-revision');

        // Both Shift+A and Shift+B are pressed (both priority 20)
        const shiftAbModifier = resolveActiveModifier({ ...emptyKeys, shift: true, a: true, b: true });
        expect(shiftAbModifier.id).toBe('insert-after-branch');

        // Both A and S are pressed without shift (both priority 10)
        const asModifier = resolveActiveModifier({ ...emptyKeys, a: true, s: true });
        expect(asModifier.id).toBe('squash-into');

        // Shift+S (priority 20) vs A (priority 10)
        const shiftSA = resolveActiveModifier({ ...emptyKeys, shift: true, s: true, a: true });
        expect(shiftSA.id).toBe('squash-onto');
    });

    it('pre-sorts BUILT_IN_MODIFIERS by priority in descending order', () => {
        const priorities = BUILT_IN_MODIFIERS.map((m) => m.priority);
        const isSorted = priorities.every((p, i) => i === 0 || p <= priorities[i - 1]);
        expect(isSorted).toBe(true);
    });
});
