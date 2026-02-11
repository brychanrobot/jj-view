/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

suite('Button Visibility Integration Test', function () {
    let jj: JjService;
    let scmProvider: JjScmProvider;
    let executeCommandStub: sinon.SinonStub;
    let repo: TestRepo;

    setup(async () => {
        // Create temp directory
        repo = new TestRepo();
        repo.init();

        // Initialize Service and Provider
        // Mock context
        const context = createMock<vscode.ExtensionContext>({
            subscriptions: [],
        });

        jj = new JjService(repo.path);
        const outputChannel = createMock<vscode.OutputChannel>({
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

        // Spy/Stub on vscode.commands.executeCommand to check for setContext
        executeCommandStub = sinon.stub(vscode.commands, 'executeCommand');
        executeCommandStub.callThrough(); // Call original for other commands
    });

    teardown(() => {
        // Cleanup
        scmProvider.dispose();
        if (executeCommandStub) {
            executeCommandStub.restore();
        }
        repo.dispose();
    });

    test('Sets jj.parentMutable to true when parent is mutable', async () => {
        // Create a parent commit (by default new repo has root as parent, which is immutable)
        repo.describe('parent');
        repo.new([], 'child');

        await new Promise((r) => setTimeout(r, 100));

        await scmProvider.refresh();

        // Verify setContext was called with 'jj.parentMutable', true
        const setContextCalls = executeCommandStub
            .getCalls()
            .filter((call) => call.args[0] === 'setContext' && call.args[1] === 'jj.parentMutable');

        // Assert we got at least one call
        assert.ok(setContextCalls.length > 0, 'Should have called setContext for parentMutable');
        // Check the last call's value
        const lastCall = setContextCalls[setContextCalls.length - 1];
        assert.strictEqual(lastCall.args[2], true, 'Parent should be mutable');
    });

    test('Sets jj.parentMutable to false when parent is root', async () => {
        // At start, parent of @ is root, which is immutable
        await scmProvider.refresh();

        const setContextCalls = executeCommandStub
            .getCalls()
            .filter((call) => call.args[0] === 'setContext' && call.args[1] === 'jj.parentMutable');

        assert.ok(setContextCalls.length > 0, 'Should have called setContext for parentMutable');
        const lastCall = setContextCalls[setContextCalls.length - 1];
        assert.strictEqual(lastCall.args[2], false, 'Root parent should be immutable');
    });

    test('Sets jj.hasChild', async () => {
        // Create a child of current
        repo.describe('parent');
        const parentId = repo.getChangeId('@');
        repo.new([], 'child');

        // Go back to parent
        repo.edit(parentId);

        await scmProvider.refresh();

        const setContextCalls = executeCommandStub
            .getCalls()
            .filter((call) => call.args[0] === 'setContext' && call.args[1] === 'jj.hasChild');

        assert.ok(setContextCalls.length > 0, 'Should have called setContext for hasChild');
        const lastCall = setContextCalls[setContextCalls.length - 1];
        assert.strictEqual(lastCall.args[2], true, 'Should have child');
    });
});
