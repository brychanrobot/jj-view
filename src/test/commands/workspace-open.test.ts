/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { workspaceOpenInCurrentWindowCommand, workspaceOpenInNewWindowCommand } from '../../commands/workspace-open';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('workspace open commands', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('opens the workspace from a context-menu argument in the current window', async () => {
        const workspace = repo.workspaceAdd('feature');

        await workspaceOpenInCurrentWindowCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.nav.foldersOpened).toEqual([
            {
                folderUri: expect.objectContaining({ fsPath: Uri.file(workspace.path).fsPath }),
                forceNewWindow: false,
            },
        ]);
    });

    test('opens the selected workspace in a new window', async () => {
        const workspace = repo.workspaceAdd('feature');

        await workspaceOpenInNewWindowCommand(ctx, { workspaceName: 'feature' });

        expect(ctx.host.nav.foldersOpened).toEqual([
            {
                folderUri: expect.objectContaining({ fsPath: Uri.file(workspace.path).fsPath }),
                forceNewWindow: true,
            },
        ]);
    });

    test('opens the workspace selected from the QuickPick', async () => {
        const workspace = repo.workspaceAdd('feature');
        ctx.host.ui.setNextQuickPickResponse({
            label: 'feature',
            description: workspace.path,
        });

        await workspaceOpenInCurrentWindowCommand(ctx, {});

        expect(ctx.host.nav.foldersOpened).toEqual([
            {
                folderUri: expect.objectContaining({ fsPath: Uri.file(workspace.path).fsPath }),
                forceNewWindow: false,
            },
        ]);
    });

    test('does nothing when workspace selection is cancelled', async () => {
        repo.workspaceAdd('feature');
        ctx.host.ui.setNextQuickPickResponse(undefined);

        await workspaceOpenInCurrentWindowCommand(ctx, {});

        expect(ctx.host.nav.foldersOpened).toHaveLength(0);
        expect(ctx.host.ui.errorMessages).toHaveLength(0);
    });

    test('reports an error when the workspace root cannot be resolved', async () => {
        await workspaceOpenInCurrentWindowCommand(ctx, { workspaceName: 'missing' });

        expect(ctx.host.ui.errorMessages[0].prefix).toContain('Failed to open workspace "missing"');
        expect(ctx.host.nav.foldersOpened).toHaveLength(0);
    });

    test('reports an error when workspace names cannot be resolved', async () => {
        repo.dispose();

        await workspaceOpenInCurrentWindowCommand(ctx, {});

        expect(ctx.host.ui.errorMessages[0].prefix).toContain('Failed to resolve workspace');
        expect(ctx.host.nav.foldersOpened).toHaveLength(0);
    });
});
