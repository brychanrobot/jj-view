/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { newCommand } from '../../commands/new';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';

vi.mock('vscode', () => ({
    Uri: { file: (path: string) => ({ fsPath: path }) },
    window: {
        showErrorMessage: vi.fn(),
        withProgress: vi.fn().mockImplementation(async (_, task) => task()),
    },
    ProgressLocation: { Notification: 15 },
}));

describe('newCommand', () => {
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

    test('creates new empty commit', async () => {
        const beforeChangeId = repo.getChangeId('@');
        await newCommand(scmProvider, jj);
        const afterChangeId = repo.getChangeId('@');
        const parents = repo.getParents('@');

        expect(afterChangeId).not.toBe(beforeChangeId);
        expect(parents[0]).toBe(beforeChangeId);
    });
});
