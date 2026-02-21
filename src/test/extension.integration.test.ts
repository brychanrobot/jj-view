/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { Api } from '../extension';
import { TestRepo } from './test-repo';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');


    let repo: TestRepo;

    suiteSetup(async () => {
        // Assume workspace is open (ensured by .vscode-test.mjs launchArgs)
        const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
        repo = new TestRepo(workspaceRoot);
        repo.init();
    });

    test('Extension should be present', () => {
        assert.ok(vscode.extensions.getExtension('jj-view.jj-view'));
    });

    test('Extension should activate and export API', async () => {
        const extension = vscode.extensions.getExtension('jj-view.jj-view');
        assert.ok(extension, 'Extension not found');

        // Activate if not already active
        const api = await extension.activate() as Api;
        assert.ok(api, 'Extension did not return API');

        // Verify scmProvider is exported
        assert.ok(api.scmProvider, 'scmProvider not exported');
        
        // Verify dependency injection: contentProvider must be assigned for cache invalidation
        // This catches the bug where contentProvider wasn't passed to scmProvider constructor
        assert.ok(api.scmProvider.contentProvider, 'contentProvider not assigned to scmProvider');
        
        // Verify other basics
        assert.ok(api.jj, 'jj service not exported');
        
        // Verify JJ service is bound to the correct workspace
        assert.strictEqual(api.jj.workspaceRoot, repo.path, 'JJ service root mismatch');

        // Verify scmProvider has contentProvider (essential for cache invalidation fix)
        assert.ok(api.scmProvider.contentProvider, 'contentProvider not assigned to scmProvider');
    });
});
