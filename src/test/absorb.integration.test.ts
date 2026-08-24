/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { absorbCommand } from '../commands/absorb';
import type { CommentsManager } from '../comments-manager';
import type { JjScmProvider } from '../jj-scm-provider';
import { createAbsorbPayload } from '../vscode/payloads/absorb.payload';
import type { VSCodeCommandContext } from '../vscode/vscode-command-context';
import {
    createIntegrationCommandContext,
    createTestRepositoryContext,
    type TestRepositoryContext,
} from './integration-test-utils';
import { buildGraph, TestRepo } from './test-repo';
import { createMock } from './test-utils';

suite('Absorb Integration Test', function () {
    this.timeout(60000);
    let repo: TestRepo;
    let scmProvider: JjScmProvider;
    let outputChannel: vscode.LogOutputChannel;
    let contextHelper: TestRepositoryContext;
    let cmdCtx: VSCodeCommandContext;

    setup(async () => {
        repo = new TestRepo();
        await repo.init();

        outputChannel = vscode.window.createOutputChannel('JJ Test', { log: true });
        contextHelper = await createTestRepositoryContext(repo.path, outputChannel);
        scmProvider = contextHelper.scmProvider;
        cmdCtx = createIntegrationCommandContext(scmProvider, createMock<CommentsManager>({}));
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // Allow VS Code to settle before disposing repository
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (contextHelper) {
            await contextHelper.dispose();
        }
    });

    test('absorb working copy changes into parent', async () => {
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { 'file.txt': 'line 1\nline 2\nline 3\n' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { 'file.txt': 'line 1\nline 2 changed\nline 3\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await absorbCommand(cmdCtx, createAbsorbPayload([]));

        const parentContent = repo.getFileContent('@-', 'file.txt');
        assert.ok(parentContent.includes('line 2 changed'), 'Parent should have absorbed the change');
    });

    test('absorb from specific revision', async () => {
        // root -> A (introduces lineA) -> B (modifies lineA) -> C (working copy)
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { 'file.txt': 'base\n' } },
            { label: 'A', parents: ['root'], description: 'A', files: { 'file.txt': 'base\nlineA\n' } },
            { label: 'B', parents: ['A'], description: 'B', files: { 'file.txt': 'base\nlineA modified\n' } },
            { label: 'C', parents: ['B'], description: 'C', isCurrentWorkingCopy: true },
        ]);

        await absorbCommand(cmdCtx, createAbsorbPayload([{ commitId: ids.B.changeId }]));

        const contentA = repo.getFileContent(ids.A.changeId, 'file.txt');
        assert.equal(contentA, 'base\nlineA modified\n');
    });
});
