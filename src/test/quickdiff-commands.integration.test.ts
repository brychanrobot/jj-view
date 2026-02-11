/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { JjDocumentContentProvider } from '../jj-content-provider';
import { discardChangeCommand } from '../commands/discard-change';
import { squashChangeCommand } from '../commands/squash-change';
import { TestRepo, buildGraph } from './test-repo';
import { createMock } from './test-utils';

suite('Quick Diff Commands Integration Test', function () {
    let jj: JjService;
    let scmProvider: JjScmProvider;
    let repo: TestRepo;

    setup(async () => {
        repo = new TestRepo();
        repo.init();

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
        const contentProvider = new JjDocumentContentProvider(jj);
        scmProvider = new JjScmProvider(context, jj, repo.path, outputChannel, contentProvider);

        // Register a test-specific content provider to handle 'jj-view-test' scheme
        // This avoids conflict with the main extension's 'jj-view' provider
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider('jj-view-test', contentProvider),
        );

        // Override provideOriginalResource to return the test scheme
        scmProvider.provideOriginalResource = (uri: vscode.Uri) => {
             return uri.with({ scheme: 'jj-view-test', query: 'revision=@-' });
        };
    });

    teardown(async () => {
        if (scmProvider) {
            scmProvider.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('Discard Change reverts file content on disk', async () => {
        const fileName = 'discard-test.txt';
        const fileContentOriginal = 'original\n';
        const fileContentModified = 'modified\n';

        // Setup: Parent has 'original', WC has 'modified'
        await buildGraph(repo, [
            {
                label: 'parent',
                description: 'parent',
                files: { [fileName]: fileContentOriginal },
            },
            {
                parents: ['parent'],
                files: { [fileName]: fileContentModified },
                isWorkingCopy: true,
            },
        ]);

        const filePath = path.join(repo.path, fileName);
        const fileUri = vscode.Uri.file(filePath);

        // Verify initial state
        assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), fileContentModified);

        // Construct LineChange for modification
        // Original: Line 1 changed. Modified: Line 1 changed.
        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 1,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
        ];

        // Execute Discard Command
        await discardChangeCommand(scmProvider, fileUri, changes, 0);

        // Verify final state on disk
        const finalContent = fs.readFileSync(filePath, 'utf-8');
        assert.strictEqual(
            finalContent,
            fileContentOriginal,
            'File content should match original after discard',
        );
    });

    test('Squash Change moves change to parent', async () => {
        const fileName = 'squash-test.txt';
        const fileContentOriginal = 'original\n';
        const fileContentModified = 'modified\n';

        // Setup: Parent has 'original', WC has 'modified'
        await buildGraph(repo, [
            {
                label: 'parent',
                description: 'parent',
                files: { [fileName]: fileContentOriginal },
            },
            {
                parents: ['parent'],
                files: { [fileName]: fileContentModified },
                isWorkingCopy: true,
            },
        ]);

        const filePath = path.join(repo.path, fileName);
        const fileUri = vscode.Uri.file(filePath);

        // Construct LineChange for modification
        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 1,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
        ];

        // Execute Squash Command
        await squashChangeCommand(scmProvider, jj, fileUri, changes, 0);

        // Verify Parent has modified content
        const parentContent = repo.getFileContent('@-', fileName);
        // repo.getFileContent no longer trims the output
        assert.strictEqual(parentContent, fileContentModified, 'Parent should have modified content');

        // Verify WC still has modified content (implicit, but good to check)
        const wcContent = fs.readFileSync(filePath, 'utf-8');
        assert.strictEqual(wcContent, fileContentModified, 'Working copy should still have modified content');
    });
});
