/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { editCommand } from '../../commands/edit';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjResourceState } from '../../scm-resource-state';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createEditPayload } from '../../vscode/payloads/edit.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('editCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );
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
