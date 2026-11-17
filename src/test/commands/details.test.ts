/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { showDetailsCommand } from '../../core/commands/details';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import type { JjLogEntry } from '../../core/jj-types';
import type { ScmModel, ScmSnapshot } from '../../core/scm-model';
import { Uri } from '../../core/uri-utils';
import { createShowDetailsPayload } from '../../vscode/payloads/details.payload';
import type { VsCodeScmProvider } from '../../vscode/providers/vscode-scm-provider';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('showDetailsCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({ jj, rootUri: Uri.file(repo.path) });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        repo.disposeSync();
        vi.clearAllMocks();
    });

    test('calls nav.openCommitDetails for the explicitly specified revision', async () => {
        const changeId = repo.getChangeId('@');
        await showDetailsCommand(ctx, { revision: changeId });

        expect(ctx.host.ui.quickPickCalls).toHaveLength(0);
        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened[0]).toMatchObject({
            repoRoot: Uri.file(repo.path),
            changeId,
        });
    });

    test('prompts via promptForRevision when payload is empty and opens arbitrary immutable commit SHA', async () => {
        const ids = await buildGraph(repo, [
            { label: 'immutableRoot', description: 'immutable base', files: { 'base.txt': 'base\n' } },
            {
                label: 'wc',
                parents: ['immutableRoot'],
                description: 'working copy',
                files: { 'wc.txt': 'wc\n' },
                isCurrentWorkingCopy: true,
            },
        ]);
        repo.config('revset-aliases."immutable_heads()"', `commit_id("${ids.immutableRoot.commitId}")`);

        ctx.host.ui.setNextQuickPickResponse({
            label: ids.immutableRoot.commitId,
            customValue: ids.immutableRoot.commitId,
        });

        await showDetailsCommand(ctx, {});

        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(ctx.host.ui.quickPickCalls[0].options?.placeHolder).toBe('Select or enter a revision to view details');
        expect(ctx.host.ui.quickPickCalls[0].items.map((item) => item.value)).toContain(ids.immutableRoot.changeId);

        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened[0]).toMatchObject({
            repoRoot: Uri.file(repo.path),
            changeId: ids.immutableRoot.changeId,
        });
    });

    test('prompts via promptForRevision when payload is undefined and opens revision by bookmark', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'target',
                description: 'bookmarked commit',
                files: { 'a.txt': 'a\n' },
                bookmarks: ['feature-base'],
            },
            {
                label: 'wc',
                parents: ['target'],
                description: 'working copy',
                files: { 'b.txt': 'b\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        ctx.host.ui.setNextRevisionPromptResponse('feature-base');

        await showDetailsCommand(ctx);

        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened[0]).toMatchObject({
            repoRoot: Uri.file(repo.path),
            changeId: ids.target.changeId,
        });
    });

    test('returns early with no opened details and no errors when user cancels picker', async () => {
        ctx.host.ui.setNextRevisionPromptResponse(undefined);

        await showDetailsCommand(ctx, {});

        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(0);
        expect(ctx.host.ui.errorMessages).toHaveLength(0);
    });

    test('treats whitespace-only revisions as omitted or cancelled without calling jj with blank input', async () => {
        const changeId = repo.getChangeId('@');

        ctx.host.ui.setNextRevisionPromptResponse('   ');
        await showDetailsCommand(ctx, { revision: '   ' });

        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(0);
        expect(ctx.host.ui.errorMessages).toHaveLength(0);

        ctx.host.ui.setNextRevisionPromptResponse(`  ${changeId}  `);
        await showDetailsCommand(ctx, {});

        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened[0]).toMatchObject({
            repoRoot: Uri.file(repo.path),
            changeId,
        });
    });

    test('createShowDetailsPayload extracts explicit revision, handles SCM groups, and leaves empty args undefined', () => {
        expect(createShowDetailsPayload([])).toEqual({ revision: undefined });
        expect(createShowDetailsPayload(['abc'])).toEqual({ revision: 'abc' });
        expect(createShowDetailsPayload([{ id: 'jj.group.workingCopy', resourceStates: [] }])).toEqual({
            revision: '@',
        });

        const emptyAncestorGroup = { id: 'ancestor-0', resourceStates: [] };
        const mockScmProvider = createMock<VsCodeScmProvider>({
            scmModel: createMock<ScmModel>({
                snapshot: createMock<ScmSnapshot>({
                    ancestors: [
                        {
                            entry: createMock<JjLogEntry>({ change_id: 'ancestor-change-id' }),
                            prefix: '@-1',
                            isMutable: true,
                            canSquash: false,
                            changes: [],
                            label: '@-1',
                            contextValue: 'jj.group.allowShowDetails',
                        },
                    ],
                }),
            }),
        });
        expect(createShowDetailsPayload([emptyAncestorGroup], mockScmProvider)).toEqual({
            revision: 'ancestor-change-id',
        });
    });

    test('reports ambiguity error for multi-match or bare divergent revset and opens offset-qualified divergent entry', async () => {
        repo.describe('version 1');
        const baseChangeId = repo.getChangeId('@');
        const commitIdV1 = repo.getCommitId('@');
        repo.describe('version 2');
        repo.bookmark('old-version', commitIdV1);

        await showDetailsCommand(ctx, { revision: baseChangeId });
        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(0);
        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('is divergent');

        await showDetailsCommand(ctx, { revision: `change_id(${baseChangeId})` });
        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(0);
        expect(ctx.host.ui.errorMessages).toHaveLength(2);
        expect(ctx.host.ui.errorMessages[1]).toContain('matched multiple commits');

        ctx.host.ui.setNextRevisionPromptResponse(`${baseChangeId}/1`);
        await showDetailsCommand(ctx, {});

        expect(ctx.host.ui.quickPickCalls[0].items.map((item) => item.label)).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`${baseChangeId.substring(0, 8)}/0`),
                expect.stringContaining(`${baseChangeId.substring(0, 8)}/1`),
            ]),
        );
        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened[0]).toMatchObject({
            repoRoot: Uri.file(repo.path),
            changeId: `${baseChangeId}/1`,
            isDivergent: true,
            changeIdOffset: 1,
        });
    });

    test('shows error when getLog fails or logEntry is missing', async () => {
        await showDetailsCommand(ctx, { revision: 'invalid-nonexistent-rev' });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Error showing details');

        await showDetailsCommand(ctx, { revision: 'none()' });

        expect(ctx.host.ui.errorMessages).toHaveLength(2);
        expect(ctx.host.ui.errorMessages[1]).toContain('No log entry found for revision: none()');
    });
});
