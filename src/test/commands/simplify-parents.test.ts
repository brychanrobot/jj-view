/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { simplifyParentsCommand } from '../../core/commands/simplify-parents';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('simplifyParentsCommand', () => {
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
            rootUri: Uri.file(repo.path),
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(async () => {
        vi.clearAllMocks();
        await repo.dispose();
    });

    test('removes redundant ancestor parent from merge commit', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C', description: 'C' },
            { label: 'B', parents: ['C'], description: 'B' },
            { label: 'A', parents: ['B', 'C'], description: 'A', isCurrentWorkingCopy: true },
        ]);

        const beforeLogs = await jj.getLog({ revision: graph.A.changeId, omitChanges: true });
        expect(beforeLogs).toHaveLength(1);
        expect(beforeLogs[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId, graph.C.changeId]);

        await simplifyParentsCommand(ctx, { revisions: [graph.A.changeId] });

        const afterLogs = await jj.getLog({ revision: graph.A.changeId, omitChanges: true });
        expect(afterLogs).toHaveLength(1);
        expect(afterLogs[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId]);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'simplifyParents' });
        expect(ctx.host.ui.progressTitles).toContain('Simplifying parents...');
        expect(ctx.host.ui.infoMessages).toContain('Simplified parents for 1 change(s).');
    });

    test('simplifies parents for multiple revisions', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C', description: 'C' },
            { label: 'B', parents: ['C'], description: 'B' },
            { label: 'A1', parents: ['B', 'C'], description: 'A1' },
            { label: 'A2', parents: ['B', 'C'], description: 'A2', isCurrentWorkingCopy: true },
        ]);

        await simplifyParentsCommand(ctx, { revisions: [graph.A1.changeId, graph.A2.changeId] });

        const logsA1 = await jj.getLog({ revision: graph.A1.changeId, omitChanges: true });
        const logsA2 = await jj.getLog({ revision: graph.A2.changeId, omitChanges: true });
        expect(logsA1[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId]);
        expect(logsA2[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId]);
        expect(ctx.host.ui.infoMessages).toContain('Simplified parents for 2 change(s).');
    });

    test('prompts for revision when revisions payload is omitted', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C', description: 'C' },
            { label: 'B', parents: ['C'], description: 'B' },
            { label: 'A', parents: ['B', 'C'], description: 'A', isCurrentWorkingCopy: true },
        ]);

        ctx.host.ui.setNextRevisionPromptResponse(graph.A.changeId);

        await simplifyParentsCommand(ctx);

        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(ctx.host.ui.quickPickCalls[0].options?.placeHolder).toBe('Select revision to simplify parents');

        const afterLogs = await jj.getLog({ revision: graph.A.changeId, omitChanges: true });
        expect(afterLogs[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId]);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'simplifyParents' });
    });

    test('returns early without mutating when prompt is cancelled', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C', description: 'C' },
            { label: 'B', parents: ['C'], description: 'B' },
            { label: 'A', parents: ['B', 'C'], description: 'A', isCurrentWorkingCopy: true },
        ]);

        ctx.host.ui.setNextRevisionPromptResponse(undefined);

        await simplifyParentsCommand(ctx, {});

        const afterLogs = await jj.getLog({ revision: graph.A.changeId, omitChanges: true });
        expect(afterLogs[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId, graph.C.changeId]);
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
        expect(ctx.host.ui.progressTitles).toHaveLength(0);
    });

    test('JjService.simplifyParents throws when revisions array is empty or whitespace-only', async () => {
        await expect(jj.simplifyParents([])).rejects.toThrow();
        await expect(jj.simplifyParents(['   '])).rejects.toThrow();
    });

    test('deduplicates duplicate revisions and reports unique change count', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C', description: 'C' },
            { label: 'B', parents: ['C'], description: 'B' },
            { label: 'A', parents: ['B', 'C'], description: 'A', isCurrentWorkingCopy: true },
        ]);

        await simplifyParentsCommand(ctx, { revisions: [graph.A.changeId, graph.A.changeId] });

        const afterLogs = await jj.getLog({ revision: graph.A.changeId, omitChanges: true });
        expect(afterLogs[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId]);
        expect(ctx.host.ui.infoMessages).toContain('Simplified parents for 1 change(s).');
    });

    test('falls back to prompt for whitespace-only revisions and returns early on whitespace-only prompt input', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C', description: 'C' },
            { label: 'B', parents: ['C'], description: 'B' },
            { label: 'A', parents: ['B', 'C'], description: 'A', isCurrentWorkingCopy: true },
        ]);

        ctx.host.ui.setNextRevisionPromptResponse('   ');

        await simplifyParentsCommand(ctx, { revisions: ['   '] });

        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        const afterLogs = await jj.getLog({ revision: graph.A.changeId, omitChanges: true });
        expect(afterLogs[0].parents.map((p) => p.change_id)).toEqual([graph.B.changeId, graph.C.changeId]);
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    test('resolves without waiting for info notification dismissal', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C', description: 'C' },
            { label: 'B', parents: ['C'], description: 'B' },
            { label: 'A', parents: ['B', 'C'], description: 'A', isCurrentWorkingCopy: true },
        ]);

        vi.spyOn(ctx.host.ui, 'showInformation').mockImplementation(() => new Promise<undefined>(() => {}));

        await expect(simplifyParentsCommand(ctx, { revisions: [graph.A.changeId] })).resolves.toBeUndefined();
    });

    test('shows error message when simplifyParents fails', async () => {
        await simplifyParentsCommand(ctx, { revisions: ['nonexistent-revision-xyz'] });

        expect(ctx.host.ui.errorMessages.length).toBeGreaterThan(0);
        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to simplify parents');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });
});
