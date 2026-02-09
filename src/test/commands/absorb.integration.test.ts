/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { JjScmProvider } from '../../jj-scm-provider';
import { JjService } from '../../jj-service';
import { TestRepo, buildGraph } from '../test-repo';
import { absorbCommand } from '../../commands/absorb';

suite('Absorb Integration Test', function () {
    this.timeout(60000);
    let repo: TestRepo;
    let jj: JjService;
    let scmProvider: JjScmProvider;
    let outputChannel: vscode.OutputChannel;

    setup(async () => {
        repo = new TestRepo();
        await repo.init();
        jj = new JjService(repo.path);

        outputChannel = vscode.window.createOutputChannel('JJ Test');

        const context = {
            subscriptions: [],
            extensionUri: vscode.Uri.file(__dirname),
        } as unknown as vscode.ExtensionContext;

        scmProvider = new JjScmProvider(context, jj, repo.path, outputChannel);
    });

    teardown(async () => {
        scmProvider.dispose();
        await repo.dispose();
    });

    test('absorb working copy changes into parent', async () => {
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { 'file.txt': 'line 1\nline 2\nline 3\n' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { 'file.txt': 'line 1\nline 2 changed\nline 3\n' },
                isWorkingCopy: true,
            },
        ]);

        await absorbCommand(scmProvider, jj, []);

        const parentContent = repo.getFileContent('@-', 'file.txt');
        assert.ok(parentContent.includes('line 2 changed'), 'Parent should have absorbed the change');
    });

    test('absorb from specific revision', async () => {
        // root -> A (introduces lineA) -> B (modifies lineA) -> C (working copy)
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { 'file.txt': 'base\n' } },
            { label: 'A', parents: ['root'], description: 'A', files: { 'file.txt': 'base\nlineA\n' } },
            { label: 'B', parents: ['A'], description: 'B', files: { 'file.txt': 'base\nlineA modified\n' } },
            { label: 'C', parents: ['B'], description: 'C', isWorkingCopy: true },
        ]);

        await absorbCommand(scmProvider, jj, [{ commitId: ids['B'].changeId }]);

        const contentA = repo.getFileContent(ids['A'].changeId, 'file.txt');
        assert.equal(contentA, 'base\nlineA modified\n');
    });
});
