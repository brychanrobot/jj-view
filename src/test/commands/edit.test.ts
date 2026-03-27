/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { editCommand } from '../../commands/edit';
import { JjResourceState, JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('editCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({ refresh: vi.fn() });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('edits specified commit', async () => {
        // Setup: Parent -> Child. Currently at Child.
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isWorkingCopy: true },
        ]);

        // Edit parent
        await editCommand(scmProvider, jj, [ids['parent'].changeId]);

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids['parent'].changeId);
    });

    test('edits from parent resource group header', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isWorkingCopy: true },
        ]);

        const mockState = createMock<JjResourceState>({ revision: ids['parent'].changeId });
        const mockParentGroup = createMock<vscode.SourceControlResourceGroup>({
            id: 'ancestor-0',
            label: 'Parent: ...',
            resourceStates: [mockState],
        });

        await editCommand(scmProvider, jj, [mockParentGroup]);

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids['parent'].changeId);
    });
});
