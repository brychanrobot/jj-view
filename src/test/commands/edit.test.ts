/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { editCommand } from '../../commands/edit';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjResourceState } from '../../scm-resource-state';
import { createEditPayload } from '../../vscode/payloads/edit.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('editCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    const runEdit = async (args: unknown[]) => {
        const payload = createEditPayload(args);
        await editCommand(ctx, payload);
    };

    test('edits specified commit', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isCurrentWorkingCopy: true },
        ]);

        await runEdit([ids.parent.changeId]);

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids.parent.changeId);
    });

    test('edits from parent resource group header', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isCurrentWorkingCopy: true },
        ]);

        const mockState = createMock<JjResourceState>({ revision: ids.parent.changeId });
        const mockParentGroup = createMock<vscode.SourceControlResourceGroup>({
            id: 'ancestor-0',
            label: 'Parent: ...',
            resourceStates: [mockState],
        });

        await runEdit([mockParentGroup]);

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(ids.parent.changeId);
    });
});
