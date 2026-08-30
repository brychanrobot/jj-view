/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { workspaceDeleteCommand } from '../../core/commands/workspace-delete';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('workspace delete command', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj, refresh: vi.fn() });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('prompts for workspace selection when payload is missing workspace name', async () => {
        const workspace = repo.workspaceAdd('feature');
        ctx.host.ui.setNextQuickPickResponse({
            label: 'feature',
            description: workspace.path,
        });

        await workspaceDeleteCommand(ctx, {});

        expect(ctx.host.ui.warningMessages.length).toBeGreaterThan(0);
    });

    test('prompts for workspace selection when payload has an empty string workspace name', async () => {
        const workspace = repo.workspaceAdd('feature');
        ctx.host.ui.setNextQuickPickResponse({
            label: 'feature',
            description: workspace.path,
        });

        // This tests the truthiness check fix: payload.workspaceName = '' should fall back to resolveWorkspaceName
        await workspaceDeleteCommand(ctx, { workspaceName: '' });

        expect(ctx.host.ui.warningMessages.length).toBeGreaterThan(0);
    });

    test('does not prompt or delete if selection is cancelled when payload has empty string', async () => {
        repo.workspaceAdd('feature');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await workspaceDeleteCommand(ctx, { workspaceName: '' });

        // Since quick pick returns undefined, the command should return early without warning or deleting.
        expect(ctx.host.ui.warningMessages).toHaveLength(0);
    });

    test('deletes the workspace when confirmed', async () => {
        const workspace = repo.workspaceAdd('feature');
        const YES = 'Yes, Delete Workspace';
        ctx.host.ui.setNextWarningResponse(YES);
        const refreshSpy = vi.spyOn(mockJjRepo, 'refresh').mockResolvedValue(undefined);

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.ui.warningMessages[0]).toContain('forget AND delete the directory for workspace "feature"');
        expect(repo.listWorkspaces()).not.toContain('feature');
        expect(fs.existsSync(workspace.path)).toBe(false);
        expect(refreshSpy).toHaveBeenCalled();
    });

    test('does not delete the workspace when not confirmed', async () => {
        const workspace = repo.workspaceAdd('feature');
        ctx.host.ui.setNextWarningResponse(undefined);
        const refreshSpy = vi.spyOn(mockJjRepo, 'refresh').mockResolvedValue(undefined);

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.ui.warningMessages[0]).toContain('forget AND delete the directory for workspace "feature"');
        expect(repo.listWorkspaces()).toContain('feature');
        expect(fs.existsSync(workspace.path)).toBe(true);
        expect(refreshSpy).not.toHaveBeenCalled();
    });
});
