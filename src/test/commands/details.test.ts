/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { showDetailsCommand } from '../../commands/details';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
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

        mockJjRepo = createMock<JjRepository>({ jj });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('calls nav.openCommitDetails for the specified revision', async () => {
        const changeId = repo.getChangeId('@');
        await showDetailsCommand(ctx, { revision: changeId });

        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened[0]).toMatchObject({
            repoRoot: repo.path,
            changeId,
        });
    });

    test('defaults to @ if no revision is specified in payload', async () => {
        const changeId = repo.getChangeId('@');
        await showDetailsCommand(ctx, {});

        expect(ctx.host.nav.commitDetailsOpened).toHaveLength(1);
        expect(ctx.host.nav.commitDetailsOpened[0]).toMatchObject({
            repoRoot: repo.path,
            changeId,
        });
    });

    test('shows error when getLog fails or logEntry is missing', async () => {
        await showDetailsCommand(ctx, { revision: 'invalid-nonexistent-rev' });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Error showing details');
    });
});
