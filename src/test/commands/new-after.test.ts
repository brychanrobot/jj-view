/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { newAfterCommand } from '../../commands/new-after';
import { TestRepo, buildGraph } from '../test-repo';

// Mock vscode
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showErrorMessage: vi.fn(),
            withProgress: vi.fn(async (_options, task) => await task(() => {})),
        },
    });
});

describe('newAfterCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        // Mock SCM Provider
        scmProvider = {
            refresh: vi.fn().mockResolvedValue(undefined),
            getSelectedCommitIds: vi.fn().mockReturnValue([]),
        } as unknown as JjScmProvider;
    });

    afterEach(async () => {
        repo.dispose();
    });

    it('should create a new commit after the selected commit (between commit and its children)', async () => {
        // Setup repo: root -> A -> B
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'A' },
            { label: 'B', parents: ['A'], description: 'B', isWorkingCopy: true },
        ]);
        const revA = ids['A'].changeId;
        const revB = ids['B'].changeId;

        await newAfterCommand(scmProvider, jj, [revA]);

        // Expected: root -> A -> New -> B
        const parentsOfB = repo.getParents(revB)[0];

        // B should be a child of New
        // Verify chain: B -> New -> A
        const revNew = parentsOfB;
        expect(revNew).not.toBe(revA);

        const parentsOfNew = repo.getParents(revNew)[0];
        expect(parentsOfNew).toBe(revA);

        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('should create a new commit after a leaf commit', async () => {
        // Setup repo: root -> A -> B
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'A' },
            { label: 'B', parents: ['A'], description: 'B', isWorkingCopy: true },
        ]);
        const revB = ids['B'].changeId;

        await newAfterCommand(scmProvider, jj, [revB]);

        // Expected: root -> A -> B -> New
        // New should have B as its parent
        const childrenOfB = repo.getChildren(revB);
        expect(childrenOfB.length).toBe(1);

        const revNew = childrenOfB[0];
        const parentsOfNew = repo.getParents(revNew)[0];
        expect(parentsOfNew).toBe(revB);

        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('should use selected commit if no argument provided', async () => {
        // Setup repo: root -> A -> B
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'A' },
            { label: 'B', parents: ['A'], description: 'B', isWorkingCopy: true },
        ]);
        const revA = ids['A'].changeId;
        const revB = ids['B'].changeId;

        // Simulate selection of A
        const getSelectedCommitIdsSpy = vi.spyOn(scmProvider, 'getSelectedCommitIds');
        getSelectedCommitIdsSpy.mockReturnValue([revA]);

        await newAfterCommand(scmProvider, jj, []);

        // Expected: root -> A -> New -> B
        const parentsOfB = repo.getParents(revB)[0];
        expect(parentsOfB).not.toBe(revA);

        const revNew = parentsOfB;
        const parentsOfNew = repo.getParents(revNew)[0];
        expect(parentsOfNew).toBe(revA);
    });

    it('should default to @ if no argument and no selection', async () => {
        // Setup repo: root -> Parent -> A
        const ids = await buildGraph(repo, [
            { label: 'Parent', description: 'Parent' },
            { label: 'A', parents: ['Parent'], description: 'A', isWorkingCopy: true },
        ]);
        const revA = ids['A'].changeId;

        // Mock no selection
        const getSelectedCommitIdsSpy = vi.spyOn(scmProvider, 'getSelectedCommitIds');
        getSelectedCommitIdsSpy.mockReturnValue([]);

        await newAfterCommand(scmProvider, jj, []);

        // Expected: root -> Parent -> A -> New
        const childrenOfA = repo.getChildren(revA);
        expect(childrenOfA.length).toBe(1);

        const revNew = childrenOfA[0];
        const parentsOfNew = repo.getParents(revNew)[0];
        expect(parentsOfNew).toBe(revA);
    });

    it('should support multiple selected commits (insert after multiple)', async () => {
        // Setup repo: root -> A -> B -> C
        //                     \-> X -> Y
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'A' },
            { label: 'B', parents: ['A'], description: 'B' },
            { label: 'C', parents: ['B'], description: 'C' },
            { label: 'X', parents: ['A'], description: 'X' },
            { label: 'Y', parents: ['X'], description: 'Y' },
        ]);
        const revB = ids['B'].changeId;
        const revX = ids['X'].changeId;

        // Mock multiple selection
        const getSelectedCommitIdsSpy = vi.spyOn(scmProvider, 'getSelectedCommitIds');
        getSelectedCommitIdsSpy.mockReturnValue([revB, revX]);

        await newAfterCommand(scmProvider, jj, []);

        // Expected: root -> A -> B -> New -> C
        //                     \-> X -/    \-> Y
        // New commit has parents B and X.
        // C and Y have parent New.

        const childrenOfB = repo.getChildren(revB);
        const childrenOfX = repo.getChildren(revX);

        // B and X should have exactly 1 child, which is the New commit
        expect(childrenOfB.length).toBe(1);
        expect(childrenOfX.length).toBe(1);
        expect(childrenOfB[0]).toBe(childrenOfX[0]);

        const newCommitId = childrenOfB[0];

        // C and Y should have the new commit as parent
        const parentsOfC = repo.getParents(ids['C'].changeId);
        const parentsOfY = repo.getParents(ids['Y'].changeId);
        expect(parentsOfC[0]).toBe(newCommitId);
        expect(parentsOfY[0]).toBe(newCommitId);

        expect(scmProvider.refresh).toHaveBeenCalled();
    });
});
