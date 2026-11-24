/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { workspaceDeleteCommand } from '../../core/commands/workspace-delete';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { ScopedTempDir } from '../scoped-helpers';
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

    afterEach(async () => {
        vi.clearAllMocks();
        await repo.dispose();
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

    test('deletes the workspace when confirmed and includes shortest change ID in confirmation', async () => {
        const workspace = repo.workspaceAdd('feature');
        const fullChangeId = repo.getLog('feature@', 'change_id').trim();
        const shortestChangeId = repo.getLog('feature@', 'change_id.shortest()').trim();
        const YES = 'Yes, Delete Workspace';
        ctx.host.ui.setNextWarningResponse(YES);
        const refreshSpy = vi.spyOn(mockJjRepo, 'refresh').mockResolvedValue(undefined);

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.ui.warningMessages[0]).toContain(
            `forget AND delete the directory for workspace "feature" (change ${shortestChangeId})`,
        );
        expect(ctx.host.ui.warningMessages[0]).not.toContain(fullChangeId);
        expect(repo.listWorkspaces()).not.toContain('feature');
        expect(fs.existsSync(workspace.path)).toBe(false);
        expect(refreshSpy).toHaveBeenCalled();
    });

    test('delegates to host.system.deleteWorkspace when provided', async () => {
        repo.workspaceAdd('feature');
        const YES = 'Yes, Delete Workspace';
        ctx.host.ui.setNextWarningResponse(YES);
        const refreshSpy = vi.spyOn(mockJjRepo, 'refresh').mockResolvedValue(undefined);
        const deleteWorkspaceSpy = vi.fn(async () => {});
        ctx.host.system = {
            ...ctx.host.system,
            deleteWorkspace: deleteWorkspaceSpy,
        };

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(deleteWorkspaceSpy).toHaveBeenCalledWith(repo.path, 'feature');
        expect(refreshSpy).toHaveBeenCalled();
    });

    test('displays workspace name and clear reason when workspace is missing', async () => {
        const YES = 'Yes, Delete Workspace';
        ctx.host.ui.setNextWarningResponse(YES);

        await workspaceDeleteCommand(ctx, { workspaceName: 'missing' });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to delete workspace "missing":');
        expect(ctx.host.ui.errorMessages[0]).toContain('Could not find workspace directory');
        expect(ctx.host.ui.errorMessages[0]).not.toContain('Workspace Delete Error: Failed to delete workspace:');
    });

    test('does not delete the workspace when not confirmed', async () => {
        const workspace = repo.workspaceAdd('feature');
        const shortestChangeId = repo.getLog('feature@', 'change_id.shortest()').trim();
        ctx.host.ui.setNextWarningResponse(undefined);
        const refreshSpy = vi.spyOn(mockJjRepo, 'refresh').mockResolvedValue(undefined);

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.ui.warningMessages[0]).toContain(
            `forget AND delete the directory for workspace "feature" (change ${shortestChangeId})`,
        );
        expect(repo.listWorkspaces()).toContain('feature');
        expect(fs.existsSync(workspace.path)).toBe(true);
        expect(refreshSpy).not.toHaveBeenCalled();
    });

    test('refuses to delete the active workspace directory in Node fallback', async () => {
        const YES = 'Yes, Delete Workspace';
        ctx.host.ui.setNextWarningResponse(YES);

        await workspaceDeleteCommand(ctx, { workspaceName: 'default' });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Cannot delete the active workspace directory');
        expect(fs.existsSync(repo.path)).toBe(true);
        expect(repo.listWorkspaces()).toContain('default');
    });

    test('refuses to delete the main repository workspace owning .jj/repo from a secondary workspace', async () => {
        using siblingDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-ws-sibling-'));
        const secPath = path.join(siblingDir.path, 'sec');
        const secRepo = repo.workspaceAdd('sec', undefined, secPath);
        try {
            const secJj = new JjService(secRepo.path, NO_OP_LOGGER);
            const secMockRepo = createMock<JjRepository>({ jj: secJj, refresh: vi.fn() });
            const secCtx = new FakeCommandContext(secMockRepo);
            secCtx.host.ui.setNextWarningResponse('Yes, Delete Workspace');

            await workspaceDeleteCommand(secCtx, { workspaceName: 'default' });

            expect(secCtx.host.ui.errorMessages).toHaveLength(1);
            expect(secCtx.host.ui.errorMessages[0]).toContain(
                'Cannot delete the main repository workspace directory containing .jj/repo',
            );
            expect(fs.existsSync(path.join(repo.path, '.jj', 'repo'))).toBe(true);
            expect(repo.listWorkspaces()).toContain('default');
        } finally {
            await secRepo.dispose();
        }
    });

    test('displays error cleanly when host.system.deleteWorkspace rejects', async () => {
        repo.workspaceAdd('feature');
        const YES = 'Yes, Delete Workspace';
        ctx.host.ui.setNextWarningResponse(YES);
        ctx.host.system = {
            ...ctx.host.system,
            deleteWorkspace: vi.fn(async () => {
                throw new Error('RPC failed');
            }),
        };

        await workspaceDeleteCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to delete workspace "feature"');
        expect(ctx.host.ui.errorMessages[0]).toContain('RPC failed');
    });

    test('displays error when resolveWorkspace fails with workspaceName omitted', async () => {
        const brokenJj = new JjService(repo.path, NO_OP_LOGGER, { binaryPath: '/non/existent/jj' });
        const brokenRepo = createMock<JjRepository>({ jj: brokenJj, refresh: vi.fn() });
        const brokenCtx = new FakeCommandContext(brokenRepo);

        await workspaceDeleteCommand(brokenCtx, {});

        expect(brokenCtx.host.ui.errorMessages).toHaveLength(1);
        expect(brokenCtx.host.ui.errorMessages[0]).toContain('Failed to resolve workspace');
    });
});
