/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { restoreCommand } from '../../commands/restore';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

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
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const args = [{ resourceUri: fileUri }];

        await restoreCommand(scmProvider, jj, args);

        const content = fs.readFileSync(path.join(repo.path, fileName), 'utf-8');
        expect(content).toBe('original');
    });
});
