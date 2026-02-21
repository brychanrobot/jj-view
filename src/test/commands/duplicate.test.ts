/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { duplicateCommand } from '../../commands/duplicate';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('duplicateCommand', () => {
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

    test('duplicates specified commit', async () => {
        repo.describe('original');
        const originalChangeId = repo.getChangeId('@');

        await duplicateCommand(scmProvider, jj, [originalChangeId]);

        const logs = repo.getLogOutput('description').split('\n');
        const duplicates = logs.filter((l) => l.includes('original'));
        expect(duplicates.length).toBeGreaterThanOrEqual(2);
    });
});
