/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';
import { createMock, accessPrivate } from './test-utils';

suite('JJ Decoration Integration Test', function () {
    // Use function to allow this.timeout
    this.timeout(20000);

    let scmProvider: JjScmProvider;
    let jjService: JjService;
    let repo: TestRepo;

    // Helper to normalize paths for Windows using robust URI comparison
    function normalize(p: string): string {
        return vscode.Uri.file(p).toString();
    }

    setup(async () => {
        // Create a temporary workspace
        repo = new TestRepo();
        repo.init();

        // Instantiate services manually for control
        jjService = new JjService(repo.path);
        const context = createMock<vscode.ExtensionContext>({ subscriptions: [] });
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

        scmProvider = new JjScmProvider(context, jjService, repo.path, outputChannel);
    });

    teardown(() => {
        if (scmProvider) {
            scmProvider.dispose();
        }
        repo.dispose();
    });

    test('Decorations show Correct Status for Working Copy', async () => {
        const fileName = 'decoration_test_A.txt';
        const file1 = path.join(repo.path, fileName);
        repo.writeFile(fileName, 'content');

        // Trigger refresh
        await scmProvider.refresh();

        // Get decoration for the file
        const uri = vscode.Uri.file(file1);
        const result = scmProvider.decorationProvider.provideFileDecoration(
            uri,
            new vscode.CancellationTokenSource().token,
        );
        const decoration = result as vscode.FileDecoration | undefined;

        assert.ok(decoration, 'Decoration should be defined for new file');
        assert.strictEqual(decoration?.badge, 'A', 'Badge should be A for added file');
    });

    test('Decorations show Correct Status for Parent Commit', async () => {
        const fileName = 'parent_mod.txt';
        const filePath = path.join(repo.path, fileName);

        // 1. Create file and commit in Root
        repo.writeFile(fileName, 'base content');
        repo.describe('root');

        // 2. Create Parent commit with modification
        repo.new([], 'parent');
        repo.writeFile(fileName, 'parent modification');
        repo.getChangeId('@');

        // 3. Create Child (Working Copy) - unmodified relative to parent
        repo.new([], 'child');

        // Refresh
        await scmProvider.refresh();

        // Verify Parent Group exists
        const parentGroups = accessPrivate(scmProvider, '_parentGroups') as vscode.SourceControlResourceGroup[];
        assert.ok(parentGroups.length > 0, 'Should have parent group');

        const parentResource = parentGroups[0].resourceStates.find(
            (r) => normalize(r.resourceUri.fsPath) === normalize(filePath),
        );
        assert.ok(parentResource, 'Should find resource in parent group');

        // Verify URI has query (Crucial for decoration separation)
        assert.ok(
            parentResource.resourceUri.query.includes('jj-revision='),
            'Parent resource URI should have revision query',
        );

        // Check Decoration based on THAT specific URI
        const result = scmProvider.decorationProvider.provideFileDecoration(
            parentResource.resourceUri,
            new vscode.CancellationTokenSource().token,
        );
        const decoration = result as vscode.FileDecoration | undefined;

        // Since we modified it in parent (relative to root), status should be Modified?
        // Wait, 'getLog' for Parent returns changes relative to ITS parent.
        // Yes, Parent modified 'base content' -> 'parent modification'. So 'M'.
        assert.ok(decoration, 'Decoration should be defined for parent file');
        assert.strictEqual(decoration?.badge, 'M', 'Badge should be M for modified file in parent');
    });
});
