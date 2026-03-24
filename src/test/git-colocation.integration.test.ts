/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as cp from 'child_process';
import { checkGitColocation } from '../git-colocation';
import { TestRepo } from './test-repo';
import { JjService } from '../jj-service';

suite('Git Colocation Integration Test Suite', () => {
    let repo: TestRepo;
    let jjService: JjService;
    let sandbox: sinon.SinonSandbox;

    suiteSetup(() => {
        repo = new TestRepo();
        // Create a colocated repo
        cp.execFileSync('jj', ['git', 'init', '--colocate'], { cwd: repo.path, encoding: 'utf-8' });
        jjService = new JjService(repo.path);
    });

    suiteTeardown(() => {
        repo.dispose();
    });

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should show warning for colocated repo', async () => {
        // Mock vscode configuration to ensure git is enabled and warning is not suppressed
        const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        
        getConfigurationStub.withArgs('git').returns({
            get: (key: string) => key === 'enabled' ? true : undefined,
            has: () => true,
            inspect: () => undefined,
            update: async () => {},
        } as vscode.WorkspaceConfiguration);

        getConfigurationStub.withArgs('jj-view').returns({
            get: (key: string) => key === 'suppressGitColocationWarning' ? false : undefined,
            has: () => true,
            inspect: () => undefined,
            update: async () => {},
        } as vscode.WorkspaceConfiguration);

        // Stub getExtension to pretend vscode.git is active (since test environment might disable it)
        const getExtensionStub = sandbox.stub(vscode.extensions, 'getExtension');
        getExtensionStub.withArgs('vscode.git').returns({ id: 'vscode.git' } as vscode.Extension<vscode.ExtensionContext>);

        // Spy on showInformationMessage
        const showInformationMessageSpy = sandbox.stub(vscode.window, 'showInformationMessage');
        showInformationMessageSpy.resolves(undefined);

        await checkGitColocation(jjService);

        assert.ok(showInformationMessageSpy.calledOnce, 'Warning should be shown');
        assert.ok(showInformationMessageSpy.firstCall.args[0].includes('Colocated Jujutsu and Git repository detected'), 'Warning message should be correct');
    });

    test('should not show warning if suppressed', async () => {
        const getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        
        getConfigurationStub.withArgs('git').returns({
            get: (key: string) => key === 'enabled' ? true : undefined,
            has: () => true,
            inspect: () => undefined,
            update: async () => {},
        } as vscode.WorkspaceConfiguration);

        getConfigurationStub.withArgs('jj-view').returns({
            get: (key: string) => key === 'suppressGitColocationWarning' ? true : undefined,
            has: () => true,
            inspect: () => undefined,
            update: async () => {},
        } as vscode.WorkspaceConfiguration);

        const getExtensionStub = sandbox.stub(vscode.extensions, 'getExtension');
        getExtensionStub.withArgs('vscode.git').returns({ id: 'vscode.git' } as vscode.Extension<vscode.ExtensionContext>);

        const showInformationMessageSpy = sandbox.stub(vscode.window, 'showInformationMessage');
        showInformationMessageSpy.resolves(undefined);

        await checkGitColocation(jjService);

        assert.ok(showInformationMessageSpy.notCalled, 'Warning should not be shown when suppressed');
    });
});
