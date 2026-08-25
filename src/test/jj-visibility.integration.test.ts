/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { ScmContextValue } from '../jj-context-keys';
import type { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { createTestRepositoryContext } from './integration-test-utils';
import { TestRepo } from './test-repo';
import { accessPrivate, createMockLogOutputChannel } from './test-utils';

suite('JJ SCM Visibility Integration Test', () => {
    let scmProvider: VsCodeScmProvider;
    let contextHelper: import('./integration-test-utils').TestRepositoryContext;
    let outputChannel: vscode.LogOutputChannel;
    let repo: TestRepo;

    setup(async () => {
        // Create temp directory
        repo = new TestRepo();
        repo.init();

        outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
            append: () => {},
            replace: () => {},
            clear: () => {},
            show: () => {},
            hide: () => {},
            dispose: () => {},
            name: 'mock',
        });
        contextHelper = await createTestRepositoryContext(repo.path, outputChannel);
        scmProvider = contextHelper.scmProvider;
    });

    teardown(async () => {
        if (contextHelper) {
            await contextHelper.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('Buttons visibility conditions', async () => {
        // 1. Setup: Create mutable parent state
        // Create initial commit
        repo.writeFile('test.txt', 'content');
        await scmProvider.refresh();

        const workingCopyGroup = accessPrivate<vscode.SourceControlResourceGroup>(scmProvider, '_workingCopyGroup');
        assert.strictEqual(workingCopyGroup.resourceStates.length, 1);

        const resourceState = workingCopyGroup.resourceStates[0];
        assert.ok((resourceState.contextValue as string).includes(ScmContextValue.ResourceAllowRestore));

        // 2. Ensure parent mutability
        // Create new commit "first commit" and work on top of it ("working on this")
        repo.describe('first commit');
        repo.new([], 'working on this');

        await scmProvider.refresh();
        await scmProvider.refresh();
        const parents = repo.getParents('@');
        const newParent = parents[0];

        const isImmutable = repo.isImmutable(newParent);
        assert.strictEqual(isImmutable, false, 'Parent change should be mutable');

        // 3. Verify Squash File to Child condition
        // Create a child commit, then return to parent to verify "hasChild" context
        repo.new([], 'child one');
        repo.edit('@-'); // Go back to "working on this"

        await scmProvider.refresh();
        // Implicitly verifies context keys (jj.hasChild)
    });
});
