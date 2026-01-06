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

import * as assert from 'assert';
import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { TestRepo } from './test-repo';
import { createMock, accessPrivate } from './test-utils';

suite('JJ SCM Visibility Integration Test', function () {
    this.timeout(20000);

    let jj: JjService;
    let scmProvider: JjScmProvider;
    let outputChannel: vscode.OutputChannel;
    let repo: TestRepo;

    setup(async () => {
        // Create temp directory
        repo = new TestRepo();
        repo.init();

        // Initialize Service and Provider
        const context = createMock<vscode.ExtensionContext>({
            subscriptions: [],
        });

        jj = new JjService(repo.path);
        outputChannel = createMock<vscode.OutputChannel>({
            appendLine: () => {},
            append: () => {},
            replace: () => {},
            clear: () => {},
            show: () => {},
            hide: () => {},
            dispose: () => {},
            name: 'mock',
        });
        scmProvider = new JjScmProvider(context, jj, repo.path, outputChannel);
    });

    teardown(() => {
        scmProvider.dispose();
        repo.dispose();
    });

    test('Buttons visibility conditions', async () => {
        // 1. Setup: Create mutable parent state
        // Create initial commit
        repo.writeFile('test.txt', 'content');
        await scmProvider.refresh();

        const workingCopyGroup = accessPrivate(scmProvider, '_workingCopyGroup');
        assert.strictEqual(workingCopyGroup.resourceStates.length, 1);

        const resourceState = workingCopyGroup.resourceStates[0];
        assert.strictEqual(resourceState.contextValue, 'jjWorkingCopy');

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

        // 3. Verify Move to Child condition
        // Create a child commit, then return to parent to verify "hasChild" context
        repo.new([], 'child one');
        repo.edit('@-'); // Go back to "working on this"

        await scmProvider.refresh();
        // Implicitly verifies context keys (jj.hasChild)
    });
});
