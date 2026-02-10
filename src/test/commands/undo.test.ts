/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { undoCommand } from '../../commands/undo';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';

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
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({ refresh: vi.fn() });
    });

    afterEach(() => {
        repo.dispose();
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
