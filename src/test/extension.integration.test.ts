/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Api } from '../vscode/extension';
import { TestRepo } from './test-repo';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    let repo: TestRepo;

    suiteSetup(async () => {
        // Assume workspace is open (ensured by .vscode-test.mjs launchArgs)
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
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
        const api = (await extension.activate()) as Api;
        assert.ok(api, 'Extension did not return API');

        // Verify repositoryManager is exported
        assert.ok(api.repositoryManager, 'repositoryManager not exported');
    });

    test('Command jj-view.focusDescriptionInput should be registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('jj-view.focusDescriptionInput'), 'jj-view.focusDescriptionInput not registered');
    });
});
