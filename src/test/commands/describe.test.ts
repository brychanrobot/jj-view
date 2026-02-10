/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { setDescriptionCommand } from '../../commands/describe';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('setDescriptionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            setDescription: vi.fn(),
        });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('updates description of current commit', async () => {
        await setDescriptionCommand(scmProvider, jj, 'new description');
        const description = repo.getDescription('@');
        expect(description.trim()).toBe('new description');
    });
});
