/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { JjViewFileSystemProvider } from '../jj-view-fs-provider';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

suite('Quick Diff Integration Test', function () {
    let jj: JjService;
    let scmProvider: JjScmProvider;
    let viewFileSystemProvider: JjViewFileSystemProvider;
    let repo: TestRepo;
    let disposable: vscode.Disposable;

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
            dispose: () => {},
            name: 'mock',
        });
        
        viewFileSystemProvider = new JjViewFileSystemProvider(jj);
        scmProvider = new JjScmProvider(
            context,
            jj,
            repo.path,
            outputChannel,
            viewFileSystemProvider,
        );

        disposable = vscode.workspace.registerFileSystemProvider('jj-view-test', viewFileSystemProvider);

        // Override provideOriginalResource to return the test scheme
        scmProvider.provideOriginalResource = (uri: vscode.Uri) => {
            return uri.with({ scheme: 'jj-view-test', query: 'base=@&side=left' });
        };
    });

    teardown(async () => {
        if (scmProvider) {
            scmProvider.dispose();
        }
        if (disposable) {
            disposable.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('SCM refresh triggers content provider invalidation', async () => {
        const fileName = 'refresh-test.txt';
        repo.writeFile(fileName, 'original\n');
        repo.new(undefined, 'test');
        repo.writeFile(fileName, 'modified\n');

        const fileUri = vscode.Uri.file(repo.path + '/' + fileName);
        const originalUri = scmProvider.provideOriginalResource(fileUri) as vscode.Uri;

        // Track calls to readFile
        let readCount = 0;
        const originalReadFile = viewFileSystemProvider.readFile.bind(viewFileSystemProvider);
        viewFileSystemProvider.readFile = async (uri: vscode.Uri) => {
            if (uri.toString() === originalUri.toString()) {
                readCount++;
            }
            return originalReadFile(uri);
        };

        // 1. Initial read (simulated by VS Code opening the diff)
        await viewFileSystemProvider.readFile(originalUri);
        assert.strictEqual(readCount, 1, 'Should have read once');

        // 2. Subscribe to events
        let eventFired = false;
        viewFileSystemProvider.onDidChangeFile((events) => {
            if (events.some((e) => e.uri.toString() === originalUri.toString())) {
                eventFired = true;
            }
        });

        // 3. Trigger refresh - this should fire the event
        await scmProvider.refresh();
        assert.ok(eventFired, 'onDidChangeFile should have been fired for the original resource');
    });

    test('jj squash triggers diff base refresh', async () => {
        const fileName = 'squash-refresh.txt';
        repo.writeFile(fileName, 'original\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'modified in WC\n');

        const fileUri = vscode.Uri.file(repo.path + '/' + fileName);
        const originalUri = scmProvider.provideOriginalResource(fileUri) as vscode.Uri;

        // Register URI by reading once
        await viewFileSystemProvider.readFile(originalUri);

        let eventFired = false;
        viewFileSystemProvider.onDidChangeFile((events) => {
            if (events.some((e) => e.uri.toString() === originalUri.toString())) {
                eventFired = true;
            }
        });

        // Perform squash via the service (simulating user action)
        await jj.squash();
        await scmProvider.refresh();

        assert.ok(eventFired, 'onDidChangeFile should have been fired after squash');
    });

    test('jj edit triggers refresh for new working copy base', async () => {
        const fileName = 'edit-refresh.txt';
        repo.writeFile(fileName, 'content in v1\n');
        repo.describe('v1');
        const v1Id = repo.getWorkingCopyId();

        repo.new();
        repo.writeFile(fileName, 'content in v2\n');
        repo.describe('v2');
        const v2Id = repo.getWorkingCopyId();

        // Start editing v1
        repo.edit(v1Id);

        const fileUri = vscode.Uri.file(repo.path + '/' + fileName);
        const originalUri = scmProvider.provideOriginalResource(fileUri) as vscode.Uri;

        // Register URI by reading once
        await viewFileSystemProvider.readFile(originalUri);

        let eventFired = false;
        viewFileSystemProvider.onDidChangeFile((events) => {
            if (events.some((e) => e.uri.toString() === originalUri.toString())) {
                eventFired = true;
            }
        });

        // Switch back to v2
        await jj.edit(v2Id);
        await scmProvider.refresh();

        assert.ok(eventFired, 'onDidChangeFile should have been fired after switching base via edit');
    });
});
