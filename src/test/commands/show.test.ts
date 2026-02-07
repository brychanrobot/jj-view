/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { showCurrentChangeCommand } from '../../commands/show';
import { JjService } from '../../jj-service';
import { TestRepo } from '../test-repo';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    window: {
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    },
}));

describe('showCurrentChangeCommand', () => {
    let repo: TestRepo;
    let jj: JjService;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('shows information message with change id', async () => {
        const currentId = repo.getChangeId('@').trim();

        await showCurrentChangeCommand(jj);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Current Change ID: ${currentId}`);
    });
});
