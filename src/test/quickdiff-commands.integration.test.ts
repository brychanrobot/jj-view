/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discardChangeCommand } from '../core/commands/discard-change';
import { squashHunkIntoParentCommand } from '../core/commands/squash-selection';
import type { CommentsManager } from '../core/comments-manager';
import { Uri } from '../core/uri-utils';
import { createDiscardChangePayload } from '../vscode/payloads/discard-change.payload';
import { createSquashHunkIntoParentPayload } from '../vscode/payloads/squash-selection.payload';
import type { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { createIntegrationCommandContext, createTestRepositoryContext, waitUntil } from './integration-test-utils';
import { buildGraph, TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

suite('Quick Diff Commands Integration Test', () => {
    let repo: TestRepo;
    let canonicalPath: string;
    let scmProvider: VsCodeScmProvider;
    let contextHelper: import('./integration-test-utils').TestRepositoryContext;

    setup(async () => {
        repo = new TestRepo();
        repo.init();
        // Canonicalize path to resolve RUNNER~1 short names on Windows
        canonicalPath = fs.realpathSync(repo.path);

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
            append: () => {},
            replace: () => {},
            clear: () => {},
            show: () => {},
            hide: () => {},
            dispose: () => {},
            name: 'mock',
        });
        contextHelper = await createTestRepositoryContext(canonicalPath, outputChannel);
        scmProvider = contextHelper.scmProvider;

        await contextHelper.repository.awaitWatchersReady();
        await scmProvider.refresh({ forceSnapshot: true });
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // Small delay to allow VS Code to settle before disposing providers
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (contextHelper) {
            await contextHelper.dispose();
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
        await scmProvider.refresh({ forceSnapshot: true });

        const filePath = path.join(canonicalPath, fileName);
        const fileUri = Uri.file(filePath);

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
        const cmdCtx = createIntegrationCommandContext(scmProvider, createMock<CommentsManager>({}));
        const payload = createDiscardChangePayload([fileUri, changes, 0]);
        await discardChangeCommand(cmdCtx, payload);

        // Verify final state on disk
        const matched = await waitUntil(() => fs.readFileSync(filePath, 'utf-8') === fileContentOriginal, 5000);
        assert.ok(
            matched,
            `File content should match original after discard, got: ${fs.readFileSync(filePath, 'utf-8')}`,
        );
    });

    test('Discard Change handles start-of-file deletion', async () => {
        const fileName = 'start-deletion.txt';
        const fileContentOriginal = 'a\nb\nc\nd\ne\n';
        const fileContentModified = 'b\nc\nd\ne\n';

        // Setup: Parent has 'a\nb\nc\nd\ne\n', WC has 'b\nc\nd\ne\n' (line 'a\n' deleted)
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
        await scmProvider.refresh({ forceSnapshot: true });

        const filePath = path.join(canonicalPath, fileName);
        const fileUri = Uri.file(filePath);

        // Verify initial state
        assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), fileContentModified);

        // Construct LineChange for start-of-file deletion:
        // VS Code reports original 1..1, modified 0..0
        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 1,
                modifiedStartLineNumber: 0,
                modifiedEndLineNumber: 0,
            },
        ];

        // Execute Discard Command
        const cmdCtx = createIntegrationCommandContext(scmProvider, createMock<CommentsManager>({}));
        const payload = createDiscardChangePayload([fileUri, changes, 0]);
        await discardChangeCommand(cmdCtx, payload);

        // Verify final state on disk
        const matched = await waitUntil(() => fs.readFileSync(filePath, 'utf-8') === fileContentOriginal, 5000);
        assert.ok(
            matched,
            `File content should match original after discard, got: ${fs.readFileSync(filePath, 'utf-8')}`,
        );
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
        await scmProvider.refresh({ forceSnapshot: true });

        const filePath = path.join(canonicalPath, fileName);
        const fileUri = Uri.file(filePath);

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
        const cmdCtx = createIntegrationCommandContext(scmProvider, createMock<CommentsManager>({}));
        const payload = createDiscardChangePayload([fileUri, changes, 0]);
        await discardChangeCommand(cmdCtx, payload);

        // Verify final state on disk
        const matchedDeletion = await waitUntil(() => fs.readFileSync(filePath, 'utf-8') === fileContentOriginal, 5000);
        assert.ok(
            matchedDeletion,
            `File content should match original after discard, got: ${fs.readFileSync(filePath, 'utf-8')}`,
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
                isCurrentWorkingCopy: true,
            },
        ]);
        await scmProvider.refresh({ forceSnapshot: true });

        const filePath = path.join(canonicalPath, fileName);
        const fileUri = Uri.file(filePath);

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
        const cmdCtx = createIntegrationCommandContext(scmProvider, createMock<CommentsManager>({}));
        const payload = createSquashHunkIntoParentPayload([fileUri, changes, 0]);
        await squashHunkIntoParentCommand(cmdCtx, payload);

        // Verify Parent has modified content
        const parentContent = repo.getFileContent('@-', fileName);
        // repo.getFileContent no longer trims the output
        assert.strictEqual(parentContent, fileContentModified, 'Parent should have modified content');

        // Verify WC still has modified content (implicit, but good to check)
        const wcContent = fs.readFileSync(filePath, 'utf-8');
        assert.strictEqual(wcContent, fileContentModified, 'Working copy should still have modified content');
    });
});
