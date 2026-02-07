/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { JjService } from '../jj-service';
import { JjMergeContentProvider } from '../jj-merge-provider';
import { TestRepo } from './test-repo';

suite('JJ Merge Provider Integration Test', function () {
    this.timeout(20000);

    let jj: JjService;
    let provider: JjMergeContentProvider;
    let registration: vscode.Disposable;
    let repo: TestRepo;

    setup(async () => {
        repo = new TestRepo();
        repo.init();
        // JjService uses process.env
        jj = new JjService(repo.path); // JjService takes path
        provider = new JjMergeContentProvider(jj);
        registration = vscode.workspace.registerTextDocumentContentProvider('jj-merge-output', provider);
    });

    teardown(() => {
        registration.dispose();
        provider.clearCache();
        repo.dispose();
    });

    test('Provider resolves conflict content', async () => {
        const fileName = 'conflict.txt';
        const filePath = path.join(repo.path, fileName);

        // 1. Base
        repo.writeFile(fileName, 'base\n');
        repo.describe('base');
        const baseId = repo.getChangeId('@');

        // 2. Left
        repo.new([], 'left');
        repo.writeFile(fileName, 'left\n');

        // 3. Right
        repo.new([baseId], 'right');
        repo.writeFile(fileName, 'right\n');

        // 4. Merge
        // Get left commit id
        const leftCommitId = repo.getChangeId(`children(${baseId}) & description(substring:left)`);
        const rightCommitId = repo.getChangeId(`children(${baseId}) & description(substring:right)`);

        repo.new([leftCommitId, rightCommitId], 'merge');

        // Construct URI to match JjScmProvider (relative path + query)
        const encodedPath = encodeURIComponent(filePath);
        const fileUri = vscode.Uri.file(filePath);
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        const virtualPath = path.posix.join('/', relativePath);

        const baseUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            query: `path=${encodedPath}&part=base`,
        });
        const leftUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            query: `path=${encodedPath}&part=left`,
        });
        const rightUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            query: `path=${encodedPath}&part=right`,
        });

        // Open documents using VS Code API
        const baseDoc = await vscode.workspace.openTextDocument(baseUri);
        const leftDoc = await vscode.workspace.openTextDocument(leftUri);
        const rightDoc = await vscode.workspace.openTextDocument(rightUri);

        assert.strictEqual(baseDoc.getText().trim(), 'base');
        assert.strictEqual(leftDoc.getText().trim(), 'left');
        assert.strictEqual(rightDoc.getText().trim(), 'right');

        // Verify base document has content
        assert.ok(baseDoc.getText().length > 0, 'Base document should not be empty');
    });

    test('Provider handles URI with encoded path correctly', async () => {
        // Test specifically the encoding logic
        const fileName = 'file with spaces.txt';
        const filePath = path.join(repo.path, fileName);

        // Setup simple conflict
        repo.new();

        // Snapshot changes so they become part of the commit
        repo.writeFile(fileName, 'base');
        repo.describe('base');
        const baseId = repo.getChangeId('@');

        repo.new([], 'left');
        repo.writeFile(fileName, 'left');

        repo.new([baseId], 'right');
        repo.writeFile(fileName, 'right');

        const leftId = repo.getChangeId(`children(${baseId}) & description(substring:left)`);

        // This time explicitly use change ids
        repo.new([leftId, '@'], 'merge');

        const encodedPath = encodeURIComponent(filePath);
        const fileUri = vscode.Uri.file(filePath);
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        const virtualPath = path.posix.join('/', relativePath);

        const baseUri = fileUri.with({
            scheme: 'jj-merge-output',
            authority: 'jj-merge',
            path: virtualPath,
            query: `path=${encodedPath}&part=base`,
        });

        const doc = await vscode.workspace.openTextDocument(baseUri);
        assert.strictEqual(doc.getText().trim(), 'base');
    });
});
