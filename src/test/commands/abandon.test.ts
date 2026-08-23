/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { abandonCommand } from '../../commands/abandon';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createAbandonPayload } from '../../vscode/payloads/abandon.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { asMock } from '../vitest-utils';

describe('abandonCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        scmProvider = createMock<JjScmProvider>({
            jj,
            repo: createMock<JjRepository>({
                jj,
                rootUri: Uri.file(repo.path),
                refresh: vi.fn().mockResolvedValue(undefined),
            }),
            outputChannel: createMock<JjLoggerChannel>(NO_OP_LOGGER),
            getSelectedCommitIds: vi.fn().mockReturnValue([]),
        });

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

    const runAbandon = async (args: unknown[]) => {
        const payload = createAbandonPayload(args, scmProvider);
        await abandonCommand(ctx, payload);
    };

    const expectChangeAbandoned = (changeId: string) => {
        const visibleIds = repo.getLog('all()', 'change_id');
        expect(visibleIds).not.toContain(changeId);
    };

    const expectChangeVisible = (changeId: string) => {
        const visibleIds = repo.getLog('all()', 'change_id');
        expect(visibleIds).toContain(changeId);
    };

    test('abandons specified commit', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');
        repo.new();

        await runAbandon([{ commitId: c1 }]);

        expectChangeAbandoned(c1);

        const parents = repo.getParents('@');
        expect(parents).not.toContain(c1);
    });

    test('abandons working copy when triggered from resource group header', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');
        const scmGroup = { id: 'jj.group.workingCopy', label: 'Working Copy', resourceStates: [] };

        await runAbandon([scmGroup]);

        expectChangeAbandoned(c1);
    });

    test('abandons working copy and IGNORES selection when triggered from resource group header', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C1' },
            { label: 'C2', parents: ['C1'], isCurrentWorkingCopy: true },
        ]);
        const c1 = graph.C1.changeId;
        const c2 = graph.C2.changeId;

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([c1]);
        const scmGroup = { id: 'jj.group.workingCopy', label: 'Working Copy', resourceStates: [] };

        await runAbandon([scmGroup]);

        expectChangeAbandoned(c2);
        expectChangeVisible(c1);
    });

    test('abandons clicked commit if not in selection', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');

        await runAbandon([{ commitId: c1 }]);

        expectChangeAbandoned(c1);
    });

    test('abandons clicked commit AND selection if clicked is part of selection', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C1' },
            { label: 'C2', parents: ['C1'], isCurrentWorkingCopy: true },
        ]);
        const c1 = graph.C1.changeId;
        const c2 = graph.C2.changeId;

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([c1, c2]);
        const arg = { commitId: c1 };

        await runAbandon([arg]);

        expectChangeAbandoned(c1);
        expectChangeAbandoned(c2);
    });

    test('abandons only clicked commit if clicked is NOT in selection', async () => {
        const graph = await buildGraph(repo, [
            { label: 'C1' },
            { label: 'C2', parents: ['C1'], isCurrentWorkingCopy: true },
        ]);
        const c1 = graph.C1.changeId;
        const c2 = graph.C2.changeId;

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([c1]);
        const arg = { commitId: c2 };

        await runAbandon([arg]);

        expectChangeAbandoned(c2);
        expectChangeVisible(c1);

        const parents = repo.getParents('@');
        expect(parents).toContain(c1);
    });

    test('falls back to selection if no click argument', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');

        repo.new();

        asMock(scmProvider.getSelectedCommitIds).mockReturnValue([c1]);

        await runAbandon([]);

        expectChangeAbandoned(c1);
    });

    test('prompts for input if no selection and no click arg', async () => {
        repo.new();
        const c1 = repo.getChangeId('@');
        repo.new();

        ctx.host.ui.setNextRevisionPromptResponse(c1);

        await runAbandon([]);

        expectChangeAbandoned(c1);
    });

    test('abandons merge commit with multiple parents', async () => {
        const graph = await buildGraph(repo, [
            { label: 'p1', files: { 'p1.txt': 'p1' } },
            { label: 'p2', files: { 'p2.txt': 'p2' } },
            { label: 'merge', parents: ['p1', 'p2'], description: 'Merge Commit', isCurrentWorkingCopy: true },
        ]);
        const mergeChangeId = graph.merge.changeId;

        await runAbandon([{ commitId: mergeChangeId }]);

        expectChangeAbandoned(mergeChangeId);
    });
});
