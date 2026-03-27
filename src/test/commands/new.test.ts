/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { newCommand } from '../../commands/new';
import { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

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
