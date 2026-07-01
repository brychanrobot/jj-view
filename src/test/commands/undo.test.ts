/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { undoCommand } from '../../commands/undo';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('undoCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        scmProvider = createMock<JjScmProvider>({ refresh: vi.fn() });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('reverts previous action', async () => {
        const initialChangeId = repo.getChangeId('@');
        repo.new(['@'], 'step 1');

        await undoCommand(scmProvider, jj);

        const currentChangeId = repo.getChangeId('@');
        expect(currentChangeId).toBe(initialChangeId);
    });
});
