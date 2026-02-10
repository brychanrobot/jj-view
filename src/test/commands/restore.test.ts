/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import * as path from 'path';
import * as fs from 'fs';
import { restoreCommand } from '../../commands/restore';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('restoreCommand', () => {
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

    test('restores file content', async () => {
        const fileName = 'restore.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'original' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { [fileName]: 'modified' },
                isWorkingCopy: true,
            },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await restoreCommand(scmProvider, jj, args);

        const content = fs.readFileSync(path.join(repo.path, fileName), 'utf-8');
        expect(content).toBe('original');
    });
});
