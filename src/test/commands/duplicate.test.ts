// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { duplicateCommand } from '../../commands/duplicate';
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
