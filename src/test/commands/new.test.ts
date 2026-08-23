/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { newCommand } from '../../commands/new';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('newCommand', () => {
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
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('creates new empty commit', async () => {
        const beforeChangeId = repo.getChangeId('@');
        await newCommand(ctx);
        const afterChangeId = repo.getChangeId('@');
        const parents = repo.getParents('@');

        expect(afterChangeId).not.toBe(beforeChangeId);
        expect(parents[0]).toBe(beforeChangeId);
    });
});
