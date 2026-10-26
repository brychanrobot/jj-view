/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeService } from '../../core/code-forge-service';
import { resolveSyncCommand, syncCommand } from '../../core/commands/sync';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('syncCommand', () => {
    let jjService: JjService;
    let repo: TestRepo;
    let remoteRepos: TestRepo[] = [];
    let codeForgeService: CodeForgeService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        remoteRepos = [];
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);

        codeForgeService = createMock<CodeForgeService>({
            isEnabled: true,
            activeProvider: undefined,
            requestRefreshWithBackoffs: vi.fn(),
        });
        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: codeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(async () => {
        await repo.dispose();
        for (const r of remoteRepos) {
            await r.dispose();
        }
        remoteRepos = [];
        vi.clearAllMocks();
    });

    async function setupRemoteWithCommit(description: string, bookmark: string) {
        const remoteRepo = new TestRepo();
        remoteRepo.init();
        remoteRepos.push(remoteRepo);
        await buildGraph(remoteRepo, [
            {
                label: 'remoteCommit',
                description,
                bookmarks: [bookmark],
                isCurrentWorkingCopy: true,
            },
        ]);
        repo.addRemote('origin', remoteRepo.path);
        return remoteRepo;
    }

    test('resolveSyncCommand parses default and custom commands without jj prefix', () => {
        expect(resolveSyncCommand(undefined)).toEqual({
            subcommand: 'git',
            commandArgs: ['fetch'],
        });
        expect(resolveSyncCommand('')).toEqual({
            subcommand: 'git',
            commandArgs: ['fetch'],
        });
        expect(resolveSyncCommand('   ')).toEqual({
            subcommand: 'git',
            commandArgs: ['fetch'],
        });
        expect(resolveSyncCommand('git fetch')).toEqual({
            subcommand: 'git',
            commandArgs: ['fetch'],
        });
        expect(resolveSyncCommand('sync -a')).toEqual({
            subcommand: 'sync',
            commandArgs: ['-a'],
        });
    });

    test('runs default git fetch when syncCommand is not configured', async () => {
        await setupRemoteWithCommit('remote main commit', 'main');

        await syncCommand(ctx);

        const fetchedDesc = repo.getLog('main@origin', 'description');
        expect(fetchedDesc).toContain('remote main commit');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'sync' });
        expect(codeForgeService.requestRefreshWithBackoffs).toHaveBeenCalled();
        expect(ctx.host.ui.infoMessages).toContain('Sync successful');
    });

    test('uses custom syncCommand when configured', async () => {
        ctx.host.config.set('syncCommand', 'describe -m synced_with_custom_command');

        await syncCommand(ctx);

        const currentDesc = repo.getLog('@', 'description');
        expect(currentDesc).toContain('synced_with_custom_command');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'sync' });
        expect(codeForgeService.requestRefreshWithBackoffs).toHaveBeenCalled();
        expect(ctx.host.ui.infoMessages).toContain('Sync successful');
    });

    test('suggests Configure Sync... when default sync fails', async () => {
        // No 'origin' remote is configured, or use a failing git fetch flag via default
        repo.addRemote('origin', '/nonexistent/remote/path');
        ctx.host.ui.setNextErrorResponse('Configure Sync...');

        await syncCommand(ctx);

        expect(ctx.host.ui.errorMessages[0]).toContain('Sync failed');
        expect(ctx.host.nav.settingsOpened).toContain('jj-view.syncCommand');
    });

    test('does not suggest Configure Sync... when custom syncCommand is already set', async () => {
        ctx.host.config.set('syncCommand', 'sync -a');
        ctx.host.ui.setNextErrorResponse('Show Log');

        await syncCommand(ctx);

        expect(ctx.host.ui.errorMessages[0]).toContain('Sync failed');
        expect(ctx.host.nav.settingsOpened).toHaveLength(0);
    });
});
