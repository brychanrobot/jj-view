/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discardChangeCommand } from '../commands/discard-change';
import { squashPartialCommand } from '../commands/squash-partial';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { JjViewFileSystemProvider } from '../jj-view-fs-provider';
import { buildGraph, TestRepo } from './test-repo';
import { createMock } from './test-utils';

suite('Quick Diff Commands Integration Test', () => {
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

        // Register a test-specific content provider to handle a unique scheme per test
        // This avoids conflict with the main extension's 'jj-view' provider and parallel tests
        const uniqueScheme = `jj-view-test-${Math.random().toString(36).substring(2, 11)}`;
        jjViewProviderDisposable = vscode.workspace.registerFileSystemProvider(uniqueScheme, viewFileSystemProvider);
        context.subscriptions.push(jjViewProviderDisposable);

        scmProvider.provideOriginalResource = (uri: vscode.Uri) => {
            return uri.with({ scheme: uniqueScheme, query: 'base=@&side=left' });
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

    test('Discard Change handles middle-of-file deletion', async () => {
        const fileName = 'middle-deletion.txt';
        const fileContentOriginal = 'a\nb\nc\nd\ne\n';
        const fileContentModified = 'a\nb\nd\ne\n';

        // Setup: Parent has 'a\nb\nc\nd\ne\n', WC has 'a\nb\nd\ne\n'
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

        // Construct LineChange for deletion in the middle of the file
        // original line 3 ("c") was deleted.
        // VS Code reports modifiedStartLineNumber = 2 (the line before the deletion)
        const changes = [
            {
                originalStartLineNumber: 3,
                originalEndLineNumber: 3,
                modifiedStartLineNumber: 2,
                modifiedEndLineNumber: 0,
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
        await squashPartialCommand(scmProvider, jj, fileUri, changes, 0);

        // Verify Parent has modified content
        const parentContent = repo.getFileContent('@-', fileName);
        // repo.getFileContent no longer trims the output
        assert.strictEqual(parentContent, fileContentModified, 'Parent should have modified content');

        // Verify WC still has modified content (implicit, but good to check)
        const wcContent = fs.readFileSync(filePath, 'utf-8');
        assert.strictEqual(wcContent, fileContentModified, 'Working copy should still have modified content');
    });
});
