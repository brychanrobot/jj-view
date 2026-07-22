/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, type Page } from '@playwright/test';
import { buildGraph, TestRepo } from '../test-repo';
import {
    openFileInEditor,
    openQuickInputWithShortcut,
    pickQuickPickItem,
    rightClickAndSelect,
    test,
} from './e2e-helpers';

test.describe('View File at Revision E2E', () => {
    let repo: TestRepo;
    let page: Page;

    test.beforeEach(async ({ vscode }) => {
        repo = new TestRepo();
        repo.init();
        repo.writeFile('f.txt', 'base content\n');
        repo.describe('initial');

        // Create a non-linear graph with multiple forks off of 'initial'
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'base content\n' } },
            {
                label: 'branchA1',
                parents: ['initial'],
                description: 'branchA1',
                files: { 'f.txt': 'branchA1 content\n' },
            },
            {
                label: 'branchA2',
                parents: ['branchA1'],
                description: 'branchA2',
                files: { 'f.txt': 'branchA2 content\n' },
            },
            {
                label: 'branchB1',
                parents: ['initial'],
                description: 'branchB1',
                files: { 'f.txt': 'branchB1 content\n' },
            },
            {
                label: 'branchB2',
                parents: ['branchB1'],
                description: 'branchB2',
                files: { 'f.txt': 'branchB2 content\n' },
            },
            { label: 'commit1', parents: ['initial'], description: 'commit1', files: { 'f.txt': 'commit1 content\n' } },
            {
                label: 'commit2',
                parents: ['commit1'],
                description: 'commit2',
                files: { 'f.txt': 'commit2 content\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const setup = await vscode.openWorkspace(repo);
        page = setup.page;
    });

    test('View File at Revision via shortcut on non-main fork', async ({ vscode }) => {
        await openFileInEditor(vscode, page, 'f.txt');
        await openQuickInputWithShortcut(page, 'Control+Alt+v');
        await pickQuickPickItem(page, 'branchA2');

        const activeTab = page.getByRole('tab', { name: /f\.txt/, selected: true });
        await expect(activeTab).toBeVisible({ timeout: 10000 });

        // Verify editor content comes from branchA2 (different chain from working copy commit2)
        const editor = page.locator('.editor-instance .monaco-editor').first();
        await expect(editor).toContainText('branchA2 content', { timeout: 5000 });
    });

    test('View File at Revision via Tab Context Menu', async ({ vscode }) => {
        await openFileInEditor(vscode, page, 'f.txt');
        const activeTab = page.getByRole('tab', { name: 'f.txt', selected: true });
        await rightClickAndSelect(page, activeTab, 'View File at Revision...');
        await pickQuickPickItem(page, 'branchB1');

        const newActiveTab = page.getByRole('tab', { name: /f\.txt/, selected: true });
        await expect(newActiveTab).toBeVisible({ timeout: 10000 });

        // Verify editor content comes from branchB1 (different chain from working copy commit2)
        const editor = page.locator('.editor-instance .monaco-editor').first();
        await expect(editor).toContainText('branchB1 content', { timeout: 5000 });
    });

    test('View File at Revision via Explorer Context Menu', async () => {
        // Focus file explorer to show treeitem
        await page.keyboard.press('Control+Shift+E');
        const treeItem = page.getByRole('treeitem', { name: 'f.txt', exact: true });
        await expect(treeItem).toBeVisible({ timeout: 5000 });

        await rightClickAndSelect(page, treeItem, 'View File at Revision...');
        await pickQuickPickItem(page, 'commit1');

        const activeTab = page.getByRole('tab', { name: /f\.txt/, selected: true });
        await expect(activeTab).toBeVisible({ timeout: 10000 });
    });
});
