/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { workspaceForgetCommand } from '../../core/commands/workspace-forget';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('workspaceForgetCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
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

    afterEach(async () => {
        vi.clearAllMocks();
        await repo.dispose();
    });

    test('forgets the workspace when confirmed and includes shortest change ID', async () => {
        repo.workspaceAdd('feature');
        const fullChangeId = repo.getLog('feature@', 'change_id').trim();
        const shortestChangeId = repo.getLog('feature@', 'change_id.shortest()').trim();
        const YES = 'Yes, Forget Workspace';
        ctx.host.ui.setNextWarningResponse(YES);

        await workspaceForgetCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.ui.warningMessages[0]).toContain(
            `Are you sure you want to forget workspace "feature" (change ${shortestChangeId})?`,
        );
        expect(ctx.host.ui.warningMessages[0]).not.toContain(fullChangeId);
        expect(repo.listWorkspaces()).not.toContain('feature');
        expect(mockJjRepo.refresh).toHaveBeenCalled();
    });

    test('does not forget the workspace when not confirmed', async () => {
        repo.workspaceAdd('feature');
        const shortestChangeId = repo.getLog('feature@', 'change_id.shortest()').trim();
        ctx.host.ui.setNextWarningResponse(undefined);

        await workspaceForgetCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.ui.warningMessages[0]).toContain(
            `Are you sure you want to forget workspace "feature" (change ${shortestChangeId})?`,
        );
        expect(repo.listWorkspaces()).toContain('feature');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('prompts for workspace selection when workspaceName is omitted', async () => {
        repo.workspaceAdd('feature-1');
        repo.workspaceAdd('feature-2');

        ctx.host.ui.setNextQuickPickResponse({ label: 'feature-1', description: 'feature-1' });
        const YES = 'Yes, Forget Workspace';
        ctx.host.ui.setNextWarningResponse(YES);

        await workspaceForgetCommand(ctx, {});

        expect(repo.listWorkspaces()).not.toContain('feature-1');
        expect(repo.listWorkspaces()).toContain('feature-2');
    });

    test('handles errors during workspace forget and displays error with workspace name', async () => {
        const YES = 'Yes, Forget Workspace';
        const brokenJj = new JjService(repo.path, NO_OP_LOGGER, { binaryPath: '/non/existent/jj' });
        const brokenRepo = createMock<JjRepository>({
            jj: brokenJj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        const brokenCtx = new FakeCommandContext(brokenRepo);
        brokenCtx.host.ui.setNextWarningResponse(YES);

        await workspaceForgetCommand(brokenCtx, { workspaceName: 'feature' });

        expect(brokenCtx.host.ui.errorMessages).toHaveLength(1);
        expect(brokenCtx.host.ui.errorMessages[0]).toContain('Failed to forget workspace "feature":');
    });
});
