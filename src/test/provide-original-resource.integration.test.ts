/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { TestRepo, buildGraph } from './test-repo';
import { createMock } from './test-utils';

suite('JjScmProvider provideOriginalResource Integration Test', function () {
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
        scmProvider = new JjScmProvider(context, jj, repo.path, outputChannel);
    });

    teardown(async () => {
        if (scmProvider) {
            scmProvider.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('returns undefined for added file', async () => {
        const fileName = 'added.txt';
        repo.writeFile(fileName, 'new content');
        
        await scmProvider.refresh({ forceSnapshot: true });

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const originalUri = scmProvider.provideOriginalResource(fileUri);

        assert.strictEqual(originalUri, undefined, 'Should return undefined for added files');
    });

    test('returns undefined for untracked file', async () => {
        // Create an ignored file
        repo.writeFile('.jjignore', 'ignored.txt\n');
        // Manually write file without repo.writeFile (which snapshots)
        const ignoredPath = path.join(repo.path, 'ignored.txt');
        require('fs').writeFileSync(ignoredPath, 'ignored content');

        await scmProvider.refresh({ forceSnapshot: true });

        const fileUri = vscode.Uri.file(ignoredPath);
        const originalUri = scmProvider.provideOriginalResource(fileUri);

        assert.strictEqual(originalUri, undefined, 'Should return undefined for untracked/ignored files');
    });

    test('returns jj-view URI for modified file', async () => {
        const fileName = 'modified.txt';
        const fileContentOriginal = 'original content\n';
        const fileContentModified = 'modified content\n';

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

        await scmProvider.refresh({ forceSnapshot: true });

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));
        const originalUri = scmProvider.provideOriginalResource(fileUri) as vscode.Uri;

        assert.ok(originalUri, 'Should return a URI for modified files');
        assert.strictEqual(originalUri.scheme, 'jj-view', 'Scheme should be jj-view');
        
        const query = new URLSearchParams(originalUri.query);
        assert.strictEqual(query.get('base'), '@', 'Base should be @ by default');
        assert.strictEqual(query.get('side'), 'left', 'Side should be left');
    });
});
