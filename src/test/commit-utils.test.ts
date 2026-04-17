/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JjService } from '../jj-service';
import { CommitAction, JjLogEntry } from '../jj-types';
import { computeCommitActions } from '../webview/utils/commit-utils';
import { buildGraph, TestRepo } from './test-repo';

describe('computeCommitActions', () => {
    let repo: TestRepo;
    let jj: JjService;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
    });

    afterEach(() => {
        repo.dispose();
    });

    async function getCommit(revision: string): Promise<JjLogEntry> {
        const log = await jj.getLog({ revision });
        return log[0];
    }

    it('should show all actions when everything is mutable and nothing is hidden', async () => {
        const ids = await buildGraph(repo, [
            { label: 'A', parents: ['root()'] },
            { label: 'B', parents: ['A'] },
        ]);
        const commit = await getCommit(ids.B.changeId);

        const hiddenActions = new Set<CommitAction>();
        const result = computeCommitActions(commit, hiddenActions, false, false, 0, false);

        expect(result.visibleActions).toEqual({
            newChild: true,
            edit: true,
            squash: true,
            abandon: true,
        });
        expect(result.vscodeContext['jj.canEdit']).toBe(true);
        expect(result.vscodeContext['jj.canAbandon']).toBe(true);
    });

    it('should hide immutable actions', async () => {
        // Root is immutable
        const commit = await getCommit('root()');
        const hiddenActions = new Set<CommitAction>();
        const result = computeCommitActions(commit, hiddenActions, true, false, 0, false);

        expect(result.visibleActions.edit).toBe(false);
        expect(result.visibleActions.abandon).toBe(false);
        expect(result.vscodeContext['jj.canEdit']).toBe(false);
        expect(result.vscodeContext['jj.canAbandon']).toBe(false);
    });

    it('should respect hiddenActions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'A', parents: ['root()'] },
            { label: 'B', parents: ['A'] },
        ]);
        const commit = await getCommit(ids.B.changeId);

        const hiddenActions = new Set<CommitAction>(['newChild', 'squash']);
        const result = computeCommitActions(commit, hiddenActions, false, false, 0, false);

        expect(result.visibleActions.newChild).toBe(false);
        expect(result.visibleActions.squash).toBe(false);
        expect(result.visibleActions.edit).toBe(true);
        expect(result.visibleActions.abandon).toBe(true);
    });

    it('should only allow squash if there is exactly one mutable parent', async () => {
        const ids = await buildGraph(repo, [
            { label: 'A', parents: ['root()'] },
            { label: 'B', parents: ['A'] },
            { label: 'C', parents: ['root()'] },
            { label: 'Merge', parents: ['A', 'C'] },
        ]);

        // Child of root (one immutable parent)
        const commitA = await getCommit(ids.A.changeId);
        const result1 = computeCommitActions(commitA, new Set(), false, false, 0, false);
        expect(result1.visibleActions.squash).toBe(false);

        // Child of mutable (one mutable parent)
        const commitB = await getCommit(ids.B.changeId);
        const result2 = computeCommitActions(commitB, new Set(), false, false, 0, false);
        expect(result2.visibleActions.squash).toBe(true);

        // Merge commit (two parents)
        const commitMerge = await getCommit(ids.Merge.changeId);
        const result3 = computeCommitActions(commitMerge, new Set(), false, false, 0, false);
        expect(result3.visibleActions.squash).toBe(false);
    });

    it('should handle selection states correctly', async () => {
        const ids = await buildGraph(repo, [{ label: 'A', parents: ['root()'] }]);
        const commit = await getCommit(ids.A.changeId);

        // Single selection
        const result1 = computeCommitActions(commit, new Set(), false, true, 1, false);
        expect(result1.vscodeContext.viewItem).toBe('jj-commit-selected');
        expect(result1.vscodeContext['jj.canEdit']).toBe(true);

        // Multi selection
        const result2 = computeCommitActions(commit, new Set(), false, true, 2, false);
        expect(result2.vscodeContext['jj.canEdit']).toBe(false);
        expect(result2.vscodeContext['jj.canMerge']).toBe(true);
    });

    it('should prevent rebase onto self', async () => {
        const ids = await buildGraph(repo, [{ label: 'A', parents: ['root()'] }]);
        const commit = await getCommit(ids.A.changeId);

        const result = computeCommitActions(commit, new Set(), false, true, 1, false);
        expect(result.vscodeContext['jj.canRebaseOnto']).toBe(false);
    });

    it('should allow rebase onto selection when not selected', async () => {
        const ids = await buildGraph(repo, [{ label: 'A', parents: ['root()'] }]);
        const commit = await getCommit(ids.A.changeId);

        const result = computeCommitActions(commit, new Set(), false, false, 1, false);
        expect(result.vscodeContext['jj.canRebaseOnto']).toBe(true);
    });

    it('should only allow absorb if at least one parent is mutable', async () => {
        const ids = await buildGraph(repo, [
            { label: 'A', parents: ['root()'] },
            { label: 'B', parents: ['A'] },
        ]);

        // Parent is root (immutable)
        const commitA = await getCommit(ids.A.changeId);
        const result1 = computeCommitActions(commitA, new Set(), false, false, 0, false);
        expect(result1.vscodeContext['jj.canAbsorb']).toBe(false);

        // Parent is mutable
        const commitB = await getCommit(ids.B.changeId);
        const result2 = computeCommitActions(commitB, new Set(), false, false, 0, false);
        expect(result2.vscodeContext['jj.canAbsorb']).toBe(true);
    });

    it('should restrict canAbsorb and canEdit to single selection', async () => {
        const ids = await buildGraph(repo, [
            { label: 'A', parents: ['root()'] },
            { label: 'B', parents: ['A'] },
        ]);
        const commit = await getCommit(ids.B.changeId);

        // Selected in multi-selection
        const result1 = computeCommitActions(commit, new Set(), false, true, 2, false);
        expect(result1.vscodeContext['jj.canEdit']).toBe(false);
        expect(result1.vscodeContext['jj.canAbsorb']).toBe(false);

        // Unselected while others are selected
        const result2 = computeCommitActions(commit, new Set(), false, false, 2, false);
        expect(result2.vscodeContext['jj.canEdit']).toBe(true);
        expect(result2.vscodeContext['jj.canAbsorb']).toBe(true);
    });

    it('should disable multi-item actions if selection contains immutable commits', async () => {
        const ids = await buildGraph(repo, [{ label: 'A', parents: ['root()'] }]);
        const commit = await getCommit(ids.A.changeId);

        // Selection has immutable commit (e.g. root)
        const result = computeCommitActions(commit, new Set(), false, true, 2, true);

        expect(result.vscodeContext['jj.canAbandon']).toBe(false);
        expect(result.vscodeContext['jj.canNewBefore']).toBe(false);
        expect(result.vscodeContext['jj.canNewAfter']).toBe(false);
    });

    it('should handle canNewChild and canDuplicate in single-item context', async () => {
        const ids = await buildGraph(repo, [{ label: 'A', parents: ['root()'] }]);
        const commit = await getCommit(ids.A.changeId);

        // Single selection
        const result1 = computeCommitActions(commit, new Set(), false, true, 1, false);
        expect(result1.vscodeContext['jj.canNewChild']).toBe(true);
        expect(result1.vscodeContext['jj.canDuplicate']).toBe(true);

        // Multi selection
        const result2 = computeCommitActions(commit, new Set(), false, true, 2, false);
        expect(result2.vscodeContext['jj.canNewChild']).toBe(false);
        expect(result2.vscodeContext['jj.canDuplicate']).toBe(false);
    });
});
