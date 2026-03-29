/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { JjViewFileSystemProvider } from '../jj-view-fs-provider';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

suite('Quick Diff Integration Test', function () {
    let jj: JjService;
    let scmProvider: JjScmProvider;
    let viewFileSystemProvider: JjViewFileSystemProvider;
    let repo: TestRepo;
    let canonicalPath: string;
    let disposable: vscode.Disposable;

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
            dispose: () => {},
            name: 'mock',
        });

        viewFileSystemProvider = new JjViewFileSystemProvider(jj);
        scmProvider = new JjScmProvider(context, jj, canonicalPath, outputChannel, viewFileSystemProvider);

        disposable = vscode.workspace.registerFileSystemProvider('jj-view-test', viewFileSystemProvider);

        // Override provideOriginalResource to return the test scheme
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
        if (disposable) {
            disposable.dispose();
        }
    });

    /**
     * Helper to wait for an onDidChangeFile event.
     * More robust than immediate assertions after an action.
     */
    async function waitForEvent(
        event: vscode.Event<vscode.FileChangeEvent[]>,
        predicate: (events: vscode.FileChangeEvent[]) => boolean,
        timeout = 30000,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                handle.dispose();
                reject(new Error(`Event timeout after ${timeout}ms. Predicate never matched.`));
            }, timeout);
            const handle = event((e) => {
                const matched = predicate(e);
                console.log(`[Test Log] Received ${e.length} file changes. Matched: ${matched}`);
                for (const change of e) {
                    console.log(`[Test Log]   - URI: ${change.uri.toString()} (Scheme: ${change.uri.scheme})`);
                }
                if (matched) {
                    clearTimeout(timer);
                    handle.dispose();
                    resolve();
                }
            });
        });
    }

    function isSameUri(u1: vscode.Uri, u2: vscode.Uri): boolean {
        return (
            u1.scheme === u2.scheme &&
            u1.path.toLowerCase().replace(/\\/g, '/') === u2.path.toLowerCase().replace(/\\/g, '/') &&
            u1.query.toLowerCase() === u2.query.toLowerCase()
        );
    }

    test('SCM refresh triggers content provider invalidation', async () => {
        const fileName = 'refresh-test.txt';
        repo.writeFile(fileName, 'original\n');
        repo.new(undefined, 'test');
        repo.writeFile(fileName, 'modified\n');

        const fileUri = vscode.Uri.file(canonicalPath + '/' + fileName);
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
        const eventPromise = waitForEvent(viewFileSystemProvider.onDidChangeFile, (events) => {
            return events.some((e) => e.uri.toString().toLowerCase() === originalUri.toString().toLowerCase());
        });

        // 3. Trigger refresh - this should fire the event
        await scmProvider.refresh();
        await eventPromise;
    });

    test('jj squash triggers diff base refresh', async () => {
        const fileName = 'squash-refresh.txt';
        repo.writeFile(fileName, 'original\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'modified in WC\n');

        const fileUri = vscode.Uri.file(path.join(canonicalPath, fileName));
        const originalUri = scmProvider.provideOriginalResource(fileUri) as vscode.Uri;

        // Register URI by reading once
        await viewFileSystemProvider.readFile(originalUri);

        // 2. Subscribe to events
        const eventPromise = waitForEvent(viewFileSystemProvider.onDidChangeFile, (events) => {
            return events.some((e) => e.uri.toString().toLowerCase() === originalUri.toString().toLowerCase());
        });

        // Perform squash via the service (simulating user action)
        await jj.squash();
        await scmProvider.refresh();

        await eventPromise;
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
        await scmProvider.refresh(); // Ensure provider status is updated after repo change

        const fileUri = vscode.Uri.file(path.join(canonicalPath, fileName));
        const originalUri = (await scmProvider.provideOriginalResource(fileUri)) as vscode.Uri;
        assert.ok(originalUri, `provideOriginalResource should return a URI for ${fileUri.fsPath}`);
        console.log(`[Test Log] Registered original resource: ${originalUri.toString()}`);

        // Register URI by reading once
        await viewFileSystemProvider.readFile(originalUri);

        // 2. Subscribe to events
        const eventPromise = waitForEvent(viewFileSystemProvider.onDidChangeFile, (events) => {
            return events.some((e) => isSameUri(e.uri, originalUri));
        });

        // Switch back to v2
        await jj.edit(v2Id);
        await scmProvider.refresh();

        await eventPromise;
    });
});
