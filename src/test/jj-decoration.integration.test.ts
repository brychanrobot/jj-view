/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';
import { accessPrivate, createMock } from './test-utils';

suite('JJ Decoration Integration Test', function () {
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

    teardown(async () => {
        if (scmProvider) {
            scmProvider.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

    test('Decorations show Correct Status for Ignored Files', async () => {
        // Create an ignored file by adding a .gitignore and a file matching it
        repo.writeFile('.gitignore', 'ignored_file.txt\nignored_dir/\n');
        repo.writeFile('ignored_file.txt', 'this is ignored');
        repo.writeFile('ignored_dir/test.txt', 'also ignored');
        repo.writeFile('tracked_file.txt', 'this is tracked');

        // Wait for jj to pick up the ignore rules
        await scmProvider.refresh();

        // Check decoration for tracked file
        const trackedUri = vscode.Uri.file(path.join(repo.path, 'tracked_file.txt'));
        const pTracked = scmProvider.decorationProvider.provideFileDecoration(
            trackedUri,
            new vscode.CancellationTokenSource().token,
        ) as Promise<vscode.FileDecoration | undefined>;

        // Check decoration for ignored file
        const ignoredUri = vscode.Uri.file(path.join(repo.path, 'ignored_file.txt'));
        const pIgnored = scmProvider.decorationProvider.provideFileDecoration(
            ignoredUri,
            new vscode.CancellationTokenSource().token,
        ) as Promise<vscode.FileDecoration | undefined>;

        // Check decoration for ignored directory
        const ignoredDirUri = vscode.Uri.file(path.join(repo.path, 'ignored_dir/test.txt'));
        const pIgnoredDir = scmProvider.decorationProvider.provideFileDecoration(
            ignoredDirUri,
            new vscode.CancellationTokenSource().token,
        ) as Promise<vscode.FileDecoration | undefined>;

        const [decTracked, decIgnored, decIgnoredDir] = await Promise.all([pTracked, pIgnored, pIgnoredDir]);

        assert.ok(decTracked !== undefined, 'Tracked file should have a decoration (Added)');
        assert.strictEqual(decTracked?.badge, 'A', 'Tracked file should be Marked as Added by status');
        assert.strictEqual(decTracked?.tooltip, 'Added', 'Tracked file should NOT be Ignored');

        assert.ok(decIgnored, 'Ignored file should have a decoration');
        assert.strictEqual(decIgnored?.tooltip, 'Ignored', 'Should have Ignored tooltip');

        assert.ok(decIgnoredDir, 'Ignored directory contents should have a decoration');
        assert.strictEqual(decIgnoredDir?.tooltip, 'Ignored', 'Should have Ignored tooltip');
    });

    test('Decorations show Correct Status for .jj directory bypass', async () => {
        const jjFolder = vscode.Uri.file(path.join(repo.path, '.jj'));
        const jjContent = vscode.Uri.file(path.join(repo.path, '.jj/config.toml'));

        // Provide decorations
        const decFolder = scmProvider.decorationProvider.provideFileDecoration(
            jjFolder,
            new vscode.CancellationTokenSource().token,
        ) as vscode.FileDecoration;
        const decContent = scmProvider.decorationProvider.provideFileDecoration(
            jjContent,
            new vscode.CancellationTokenSource().token,
        ) as vscode.FileDecoration;

        assert.ok(decFolder, '.jj folder should have a decoration');
        assert.strictEqual(decFolder.tooltip, 'Ignored', 'Should have Ignored tooltip');
        assert.ok(decContent, '.jj folder contents should have a decoration');
        assert.strictEqual(decContent.tooltip, 'Ignored', 'Should have Ignored tooltip');
    });

    test('Decorations handle Force-Tracked Ignored Files', async () => {
        // Create a file that is tracked FIRST
        repo.writeFile('force_tracked.txt', 'tracked content');
        await scmProvider.refresh(); // Snapshots and tracks it

        // Now add it to .gitignore
        repo.writeFile('.gitignore', 'force_tracked.txt\n');
        await scmProvider.refresh(); // Snapshots .gitignore, but force_tracked.txt is ALREADY tracked

        const uri = vscode.Uri.file(path.join(repo.path, 'force_tracked.txt'));
        const trackedDecorationPromise = scmProvider.decorationProvider.provideFileDecoration(
            uri,
            new vscode.CancellationTokenSource().token,
        ) as Promise<vscode.FileDecoration | undefined>;

        await trackedDecorationPromise;
        // Because it was modified in the Working Copy (or Added), it should show up explicitly, BUT let's commit it so it has NO explicit status.
        repo.describe('commit force tracked');
        repo.new();
        await scmProvider.refresh();

        const committedDecorationPromise = scmProvider.decorationProvider.provideFileDecoration(
            uri,
            new vscode.CancellationTokenSource().token,
        ) as Promise<vscode.FileDecoration | undefined>;

        const committedDecoration = await committedDecorationPromise;

        // Because it is tracked (despite .gitignore), it should NOT be ignored.
        // It should be undefined because it has no explicit changes in the new empty working copy.
        assert.ok(committedDecoration === undefined, 'Force-tracked ignored file should NOT be marked as ignored');
    });

    test('Decorations clear cache and update on .gitignore change', async () => {
        const fileName = 'dynamic_ignore.txt';
        const uri = vscode.Uri.file(path.join(repo.path, fileName));

        // 1. File exists and is tracked in the working copy
        repo.writeFile(fileName, 'content');
        await scmProvider.refresh(); // Automatically tracked as 'A'

        const initialTrackedDecorationPromise = scmProvider.decorationProvider.provideFileDecoration(
            uri,
            new vscode.CancellationTokenSource().token,
        ) as Promise<vscode.FileDecoration | undefined>;
        await initialTrackedDecorationPromise;
        // Here, it would actually be marked as 'A' (Added), but essentially not ignored

        // 2. Ignore it first, then untrack it (jj file untrack requires the file to be ignored)
        repo.writeFile('.gitignore', fileName + '\n');
        repo.untrack(fileName);
        await scmProvider.refresh(); // This clears the decoration cache!

        const finalIgnoredDecorationPromise = scmProvider.decorationProvider.provideFileDecoration(
            uri,
            new vscode.CancellationTokenSource().token,
        ) as Promise<vscode.FileDecoration | undefined>;

        const finalIgnoredDecoration = await finalIgnoredDecorationPromise;
        assert.ok(finalIgnoredDecoration !== undefined, 'Should now be ignored');
        assert.strictEqual(finalIgnoredDecoration?.tooltip, 'Ignored', 'Should have Ignored tooltip');
    });
});
