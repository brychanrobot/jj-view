/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { JjService } from '../../jj-service';
import { JjScmProvider } from '../../jj-scm-provider';
import { newBeforeCommand } from '../../commands/new-before';
import { TestRepo, buildGraph } from '../test-repo';

// Mock vscode
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showErrorMessage: vi.fn(),
            withProgress: vi.fn(async (_options, task) => await task(() => {})),
        }
    });
});

describe('newBeforeCommand', () => {
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

    it('should create a new commit before the selected commit', async () => {
        // Setup repo: root -> A -> B
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'A' },
            { label: 'B', parents: ['A'], description: 'B', isWorkingCopy: true },
        ]);
        const revA = ids['A'].changeId;
        const revB = ids['B'].changeId;

        await newBeforeCommand(scmProvider, jj, [revB]);

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

    it('should use selected commit if no argument provided', async () => {
        // Setup repo: root -> A -> B
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'A' },
            { label: 'B', parents: ['A'], description: 'B', isWorkingCopy: true },
        ]);
        const revA = ids['A'].changeId;
        const revB = ids['B'].changeId;

        // Simulate selection of B
        const getSelectedCommitIdsSpy = vi.spyOn(scmProvider, 'getSelectedCommitIds');
        getSelectedCommitIdsSpy.mockReturnValue([revB]);

        await newBeforeCommand(scmProvider, jj, []);

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
        const revParent = ids['Parent'].changeId;
        const revA = ids['A'].changeId;

        // Mock no selection
        const getSelectedCommitIdsSpy = vi.spyOn(scmProvider, 'getSelectedCommitIds');
        getSelectedCommitIdsSpy.mockReturnValue([]);

        await newBeforeCommand(scmProvider, jj, []);

        // Expected: root -> Parent -> New -> A
        const parentsOfA = repo.getParents(revA)[0];
        expect(parentsOfA).not.toBe(revParent);
        
        const newCommitParent = repo.getParents(parentsOfA)[0];
        expect(newCommitParent).toBe(revParent);
    });

    it('should support multiple selected commits', async () => {
        // Setup repo: root -> A -> B
        //                          -> C
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'A' },
            { label: 'B', parents: ['A'], description: 'B' },
            { label: 'C', parents: ['A'], description: 'C' },
        ]);
        const revB = ids['B'].changeId;
        const revC = ids['C'].changeId;

        // Mock multiple selection
        const getSelectedCommitIdsSpy = vi.spyOn(scmProvider, 'getSelectedCommitIds');
        getSelectedCommitIdsSpy.mockReturnValue([revB, revC]);

        await newBeforeCommand(scmProvider, jj, []);

        // Expected: root -> A -> New -> B
        //                             -> C
        
        // B and C should have the same parent (New)
        const parentsOfB = repo.getParents(revB);
        const parentsOfC = repo.getParents(revC);
        
        expect(parentsOfB.length).toBe(1);
        expect(parentsOfC.length).toBe(1);
        expect(parentsOfB[0]).toBe(parentsOfC[0]);
        
        const newCommitId = parentsOfB[0];
        
        // New commit should have A as parent
        const parentsOfNew = repo.getParents(newCommitId);
        expect(parentsOfNew[0]).toBe(ids['A'].changeId);

        expect(scmProvider.refresh).toHaveBeenCalled();
    });
});
