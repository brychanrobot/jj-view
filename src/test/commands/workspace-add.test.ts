/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { workspaceAddCommand } from '../../core/commands/workspace-add';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('workspaceAddCommand', () => {
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
            rootUri: Uri.file(repo.path),
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('creates workspace successfully and prompts to open', async () => {
        ctx.host.ui.setNextInputBoxResponse('feature-ws');
        const OPEN = 'Open Workspace';
        ctx.host.ui.setNextInfoResponse(OPEN);

        await workspaceAddCommand(ctx);

        expect(repo.listWorkspaces()).toContain('feature-ws');
        expect(mockJjRepo.refresh).toHaveBeenCalled();
        expect(ctx.host.ui.infoMessages[0]).toContain('Workspace "feature-ws" created successfully.');
        expect(ctx.host.nav.foldersOpened).toHaveLength(1);
        expect(ctx.host.nav.foldersOpened[0].forceNewWindow).toBe(true);
    });

    test('respects custom workspacesLocation from host config', async () => {
        const customDir = path.join(repo.path, 'custom-workspaces');
        ctx.host.config.set('workspacesLocation', customDir);
        ctx.host.ui.setNextInputBoxResponse('custom-ws');
        ctx.host.ui.setNextInfoResponse(undefined);

        await workspaceAddCommand(ctx);

        expect(repo.listWorkspaces()).toContain('custom-ws');
        expect(fs.existsSync(path.join(customDir, 'custom-ws'))).toBe(true);
    });

    test('does nothing if user cancels input prompt', async () => {
        ctx.host.ui.setNextInputBoxResponse(undefined);

        await workspaceAddCommand(ctx);

        expect(repo.listWorkspaces()).not.toContain('feature-ws');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('handles errors during workspace creation and displays error', async () => {
        ctx.host.ui.setNextInputBoxResponse('default');

        await workspaceAddCommand(ctx);

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Workspace Add Error');
    });
});
