/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { discardChangeCommand } from '../commands/discard-change';
import { squashChangeCommand } from '../commands/squash-change';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { JjViewFileSystemProvider } from '../jj-view-fs-provider';
import { TestRepo, buildGraph } from './test-repo';
import { createMock } from './test-utils';

suite('Quick Diff Commands Integration Test', function () {
    let jj: JjService;
    let repo: TestRepo;
    let canonicalPath: string;
    let scmProvider: JjScmProvider;
    let viewFileSystemProvider: JjViewFileSystemProvider;
    let jjViewProviderDisposable: vscode.Disposable | undefined;

    setup(async () => {
        repo = new TestRepo();
        repo.init();
        // Canonicalize path to resolve RUNNER~1 short names on Windows
        canonicalPath = fs.realpathSync(repo.path);

        const context = createMock<vscode.ExtensionContext>({
            subscriptions: [],
        });

        jj = new JjService(canonicalPath);
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
        viewFileSystemProvider = new JjViewFileSystemProvider(jj);
        scmProvider = new JjScmProvider(context, jj, canonicalPath, outputChannel, viewFileSystemProvider);

        // Register a test-specific content provider to handle 'jj-view-test' scheme
        // This avoids conflict with the main extension's 'jj-view' provider
        jjViewProviderDisposable = vscode.workspace.registerFileSystemProvider('jj-view-test', viewFileSystemProvider);
        context.subscriptions.push(jjViewProviderDisposable);

        scmProvider.provideOriginalResource = (uri: vscode.Uri) => {
            return uri.with({ scheme: 'jj-view-test', query: 'base=@&side=left' });
        };

        // Await the initial refresh to ensure state is ready before tests start
        await scmProvider.refresh();
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // Small delay to allow VS Code to settle before disposing providers
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (scmProvider) {
            scmProvider.dispose();
        }
        if (jjViewProviderDisposable) {
            jjViewProviderDisposable.dispose();
            jjViewProviderDisposable = undefined;
        }
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
                isCurrentWorkingCopy: true,
            },
        ]);

        const filePath = path.join(canonicalPath, fileName);
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
        assert.strictEqual(finalContent, fileContentOriginal, 'File content should match original after discard');
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
                isCurrentWorkingCopy: true,
            },
        ]);

        const filePath = path.join(canonicalPath, fileName);
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
