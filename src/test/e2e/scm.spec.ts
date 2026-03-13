/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { TestRepo, buildGraph } from '../test-repo';
import { launchVSCode, focusSCM, hoverAndClick } from './e2e-helpers';

test.describe('SCM Pane E2E', () => {
    test('Displays correct groups and populates SCM input', async () => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base' } },
            { label: 'conflict-side-1', parents: ['initial'], description: 'side 1', files: { 'file.txt': 'a' } },
            { label: 'conflict-side-2', parents: ['initial'], description: 'side 2', files: { 'file.txt': 'b' } },
            { label: 'merge', parents: ['conflict-side-1', 'conflict-side-2'], description: 'merge', isWorkingCopy: false },
            { label: 'wc', parents: ['merge'], description: 'my working copy', files: { 'new-file.ts': 'console.log("hello");\n' }, isWorkingCopy: true }
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusSCM(page);

            // Verify groups
            const mergeConflictsHeader = page.getByRole('treeitem', { name: 'Merge Conflicts' });
            const workingCopyHeader = page.getByRole('treeitem', { name: /Working Copy/ });

            await expect(mergeConflictsHeader).toBeVisible();
            await expect(workingCopyHeader).toBeVisible();

            // Verify ancestor groups (merge commit is empty, so we see its parents @-2^1 and @-2^2)
            await expect(page.getByRole('treeitem', { name: /@-2\^1:.*side 1/ })).toBeVisible({ timeout: 5000 });
            await expect(page.getByRole('treeitem', { name: /@-2\^2:.*side 2/ })).toBeVisible();

            // Verify SCM input is populated with working copy description
            const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' });
            await expect(scmInputRow).toContainText('my working copy');
        } finally {
            await app.close();
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            repo.dispose();
        }
    });

    test('Top-Level Commands: Commit and New Change', async () => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base' }, isWorkingCopy: true }
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusSCM(page);
            const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' });
            await scmInputRow.click(); // Focus the editor
            
            // Set Description and Commit
            await page.keyboard.press('Control+A');
            await page.keyboard.insertText('Updated description explicitly');
            
            // Commit using button inside the Source Control view title bar
            const commitButton = page.getByRole('button', { name: 'Commit (Ctrl+Enter)' }).first();
            await commitButton.click();
            
            // Wait for description to clear out (indicating commit success)
            await expect(async () => {
                expect(repo.log()).toContain('Updated description explicitly');
            }).toPass({ timeout: 5000 });

            // Ensure wait for SCM refresh before next action
            await expect(scmInputRow).not.toContainText('Updated description explicitly', { timeout: 10000 });

            // Click New Change (+)
            const newButton = page.getByRole('button', { name: 'New Change' }).first();
            await newButton.click();
            
            // Wait for UI to reflect empty input box or wait for a specific commit in repo
            await expect(async () => {
                const wcDescription = repo.getDescription('@').trim();
                expect(wcDescription).toBe('');
            }).toPass({ timeout: 5000 });

        } finally {
            await app.close();
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            repo.dispose();
        }
    });

    test('Keyboard Shortcuts: Ctrl+S and Ctrl+Enter', async () => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base' } },
            { label: 'wc', parents: ['initial'], isWorkingCopy: true }
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusSCM(page);
            const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' });
            await scmInputRow.click();
            
            // Set Description with Ctrl+S
            await page.keyboard.press('Control+A');
            await page.keyboard.insertText('Using keyboard shortcuts');
            await page.keyboard.press('Control+S');
            
            // Wait for input to be stable (doesn't change back to what it was)
            await expect(async () => {
                expect(repo.getDescription('@').trim()).toBe('Using keyboard shortcuts');
            }).toPass({ timeout: 5000 });

            // Set Description to trigger commit
            await page.keyboard.press('Control+A');
            await page.keyboard.insertText('Commit via keyboard');
            await page.keyboard.press('Control+S');
            
            await expect(async () => {
                expect(repo.getDescription('@').trim()).toBe('Commit via keyboard');
            }).toPass({ timeout: 5000 });

            // Commit with Ctrl+Enter
            await scmInputRow.click();
            await page.keyboard.press('Control+Enter');
            
            // Wait for commit to appear in log
            await expect(async () => {
                const log = repo.log();
                expect(log).toContain('Commit via keyboard');
            }).toPass({ timeout: 5000 });

            // Wait for input to clear in UI
            await expect(scmInputRow).not.toContainText('Commit via keyboard', { timeout: 10000 });

        } finally {
            await app.close();
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            repo.dispose();
        }
    });

    test('Group-Level Actions: Abandon Working Copy and Squash Ancestor', async () => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'base.txt': '1' } },
            { label: 'ancestor', parents: ['initial'], description: 'ancestor change', files: { 'a.txt': '1' } },
            { label: 'wc', parents: ['ancestor'], description: 'wc change', files: { 'w.txt': '1' }, isWorkingCopy: true }
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusSCM(page);
            // Wait for groups to settle
            const wcGroupHeader = page.getByRole('treeitem', { name: /Working Copy/ });
            
            // Use abandon icon
            const abandonIcon = wcGroupHeader.locator('.action-item', { has: page.locator('.codicon-trash') }).first();
            await hoverAndClick(wcGroupHeader, abandonIcon);
            
            // Assert via repo that wc change is abandoned. Poll until true.
            await expect(async () => {
                const isWcChangeStillPresent = repo.log().includes(commits['wc'].changeId);
                expect(isWcChangeStillPresent).toBe(false);
            }).toPass({ timeout: 5000 });

            // Wait for SCM view to refresh before next action
            await expect(wcGroupHeader).toBeVisible();

            // Now test Squash Ancestor...
            const ancestorRow = page.getByRole('treeitem', { name: /ancestor change/ });
            const squashIcon = ancestorRow.locator('.action-item', { has: page.locator('.codicon-arrow-down') }).first();
            await hoverAndClick(ancestorRow, squashIcon);
            
            // Assert via repo that the ancestor was squashed into its parent (initial). Poll until true.
            await expect(async () => {
                const logAfterSquash = repo.log();
                expect(logAfterSquash).not.toContain('ancestor change');
            }).toPass({ timeout: 5000 });

        } finally {
            await app.close();
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            repo.dispose();
        }
    });

    test('File-Level Actions: Discard Changes and Diff Editing (Right Side)', async () => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'base', 'file2.txt': 'base2', 'file3.txt': 'base3' } },
            { label: 'wc', parents: ['initial'], description: 'wc change', files: { 'file.txt': 'mod', 'file2.txt': 'mod2', 'file3.txt': 'mod3' }, isWorkingCopy: true }
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusSCM(page);
            // Discard Changes (file3.txt)
            const wcFile3Row = page.getByRole('treeitem', { name: /file3\.txt, modified/ });
            const discardIcon = wcFile3Row.locator('.action-item', { has: page.locator('.codicon-discard') }).first();
            await hoverAndClick(wcFile3Row, discardIcon);
            
            // Assert the file was restored by polling
            await expect(async () => {
                expect(repo.getFileContent('@', 'file3.txt').trim()).toBe('base3');
            }).toPass({ timeout: 5000 });

            // File-Level Squash (file.txt)
            // Hover over file.txt in Working Copy and click Squash into Parent
            // It shares the same codicon-arrow-down icon as the group squash action
            const wcFileRow = page.getByRole('treeitem', { name: /file\.txt, modified/ });
            // Use role and more flexible title matching for reliability across VS Code versions
            const squashFileIcon = wcFileRow.getByRole('button', { name: /Squash into (Parent|Ancestor)/ }).first();
            await hoverAndClick(wcFileRow, squashFileIcon);

            // Assert via repo that file.txt changes were squashed into the parent commit
            await expect(async () => {
                const parentChanges = repo.getDiffSummary('@-');
                expect(parentChanges).toContain('A file.txt');
                const wcChanges = repo.getDiffSummary('@');
                expect(wcChanges).not.toContain('A file.txt');
            }).toPass({ timeout: 5000 });

            // Open Single File Diff (file2.txt)
            const diffFileRow = page.getByRole('treeitem', { name: /file2\.txt, modified/ });
            await diffFileRow.click();
            
            // Wait for Diff Editor
            await page.waitForSelector('.monaco-diff-editor');

            // In VS Code, diff editors have left and right. 
            // We want to edit the right side (working copy).
            const rightEditor = page.locator('.monaco-diff-editor .editor.modified');
            await rightEditor.click();
            
            // Selecting all text and typing
            // Use toPass to retry the entire typing sequence since Monaco can be finicky
            await expect(async () => {
                await rightEditor.click();
                await page.keyboard.press('Control+A');
                await page.keyboard.press('Backspace');
                await page.keyboard.insertText('edited from diff');
                await expect(rightEditor).toContainText('edited from diff', { timeout: 1000 });
            }).toPass({ timeout: 5000 });

            // Save and ensure JJ picks it up. 
            // The VS Code diff editor sometimes needs a moment or a retry.
            await expect(async () => {
                // Ensure focus before save
                await rightEditor.click();
                await page.keyboard.press('Control+s');
                
                // Wait a bit for filesystem to sync
                await page.waitForTimeout(500);

                // Verify file content on disk and in jj
                const diskContent = fs.readFileSync(path.join(repo.path, 'file2.txt'), 'utf8').trim();
                expect(diskContent).toBe('edited from diff');

                const content = repo.getFileContent('@', 'file2.txt').trim();
                expect(content).toBe('edited from diff');
            }).toPass({ timeout: 20000 });

            // Squash Into Ancestor (file.txt)
            // Need a setup with a grandparent. Let's create one on the fly.
            // Oh wait, `initial` is the parent of `wc`. Let's use `initial` as the grandparent.
            // Actually, we need to commit `wc` to make a parent, then create a new `wc` on top.
            await focusSCM(page);
            const scmInputRow2 = page.getByRole('treeitem', { name: 'Source Control Input' });
            await scmInputRow2.click();
            await page.keyboard.press('Control+A');
            await page.keyboard.insertText('commit wc');
            await page.keyboard.press('Control+Enter');
            
            await expect(async () => {
                expect(repo.getParents('@').length).toBe(1);
            }).toPass({ timeout: 5000 });
            // Now we have initial -> wc_commit -> new_wc
            // Modify file3.txt in the new working copy
            repo.writeFile('file3.txt', 'new mod3');
            
            // Click the SCM refresh button
            const refreshButton = page.getByRole('button', { name: 'Refresh' }).first();
            await refreshButton.click();

            // Wait for file3.txt to appear in SCM Working Copy
            const newWcFileRow = page.getByRole('treeitem', { name: /file3\.txt, modified/ }).first();
            await expect(newWcFileRow).toBeVisible({ timeout: 5000 });
            
            // The squashInto action should be visible because we have two mutable ancestors (the previous wc commit, and initial).
            const squashIntoIcon = newWcFileRow.getByRole('button', { name: /Squash into Ancestor/ }).first();
            await hoverAndClick(newWcFileRow, squashIntoIcon);

            // SCM QuickPick should appear for Ancestor selection
            const quickPickInput = page.getByRole('listbox');
            await expect(quickPickInput).toBeVisible({ timeout: 5000 });
            
            const ancestor2Option = page.getByRole('option', { name: /initial/i });
            await ancestor2Option.click();
            await expect(quickPickInput).not.toBeVisible({ timeout: 5000 });

            // Verify the squash happened by waiting for there to be only ONE file3.txt row (the ancestor one)
            await expect(async () => {
                const rows = page.getByRole('treeitem', { name: /file3\.txt, modified/ });
                const count = await rows.count();
                expect(count).toBe(1);
            }).toPass({ timeout: 10000 });
            
            await expect(async () => {
                const wcChanges = repo.getDiffSummary('@');
                expect(wcChanges).not.toContain('file3.txt');
                
                // The ancestor should now have the change.
                expect(repo.getFileContent('@--', 'file3.txt').trim()).toBe('new mod3');
            }).toPass({ timeout: 5000 });

        } finally {
            await app.close();
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            repo.dispose();
        }
    });

    test('Additional Actions: Absorb, Edit, Show Details, Move to Child', async () => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'base.txt': '1' } },
            { label: 'ancestor', parents: ['initial'], description: 'ancestor change', files: { 'f1.txt': '1', 'f2.txt': '1' } },
            // Working copy edit of the same file f1.txt (to test absorb) and a new one
            { label: 'wc', parents: ['ancestor'], description: 'wc change', files: { 'f1.txt': '2', 'f3.txt': '1' }, isWorkingCopy: true }
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusSCM(page);
            const wcGroupHeader = page.getByRole('treeitem', { name: /Working Copy/ });

            // 1. Absorb
            const absorbIcon = wcGroupHeader.locator('.action-item', { has: page.locator('.codicon-magnet') }).first();
            await hoverAndClick(wcGroupHeader, absorbIcon);
            
            // Wait for SCM refresh to confirm absorb (the wc change for f1.txt is consumed into ancestor)
            await expect(async () => {
                expect(repo.getFileContent(commits['ancestor'].changeId, 'f1.txt').trim()).toBe('2');
            }).toPass({ timeout: 5000 });

            // 2. Show Details
            // Use ancestorRow for group-level actions like Details
            const ancestorRow = page.getByRole('treeitem', { name: /ancestor change/ }).first();
            const detailsIcon = ancestorRow.locator('.action-item', { has: page.locator('.codicon-list-selection') }).first();
            await hoverAndClick(ancestorRow, detailsIcon);
            
            // Assert that the Commit Details panel opened (it opens as an editor tab)
            await expect(page.getByRole('tab', { name: /^Commit: / })).toBeVisible({ timeout: 5000 });

            // Ensure we switch focus back to SCM View if needed, though sidebar might still be visible
            await focusSCM(page);

            // 3. Move to Child (Pull from Ancestor)
            // Groups are expanded by default, so f2.txt is already visible.
            const ancestorFile = page.getByRole('treeitem', { name: /f2\.txt/ });
            const moveToChildIcon = ancestorFile.locator('.action-item', { has: page.locator('.codicon-arrow-up') }).first();
            await hoverAndClick(ancestorFile, moveToChildIcon);

            // Assert via repo that f2.txt from ancestor was moved to working copy
            await expect(async () => {
                const wcChanges = repo.getDiffSummary('@');
                expect(wcChanges).toContain('A f2.txt');
            }).toPass({ timeout: 5000 });

            // 4. Edit (Make ancestor the working copy)
            const editIcon = ancestorRow.locator('.action-item', { has: page.locator('.codicon-edit') }).first();
            await hoverAndClick(ancestorRow, editIcon);

            // Assert via repo that the working copy is now the ancestor
            await expect(async () => {
                const changeId = repo.getWorkingCopyId();
                expect(changeId).toBe(commits['ancestor'].changeId);
            }).toPass({ timeout: 5000 });

        } finally {
            await app.close();
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            repo.dispose();
        }
    });

    test('Multi-File Diff and Diff Editing', async () => {
        const repo = new TestRepo();
        repo.init();
        const commits = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f1.txt': '1', 'f2.txt': '1' } },
            { label: 'ancestor', parents: ['initial'], description: 'ancestor change', files: { 'f1.txt': '2', 'f2.txt': '2' } },
            { label: 'wc', parents: ['ancestor'], isWorkingCopy: true }
        ]);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusSCM(page);
            // Hover over Ancestor group
            const ancestorRowGroup = page.getByRole('treeitem', { name: /ancestor change/ });
            // Use Multi-File Diff icon (diff-multiple)
            const multiDiffIcon = ancestorRowGroup.locator('.action-item', { has: page.locator('.codicon-diff-multiple') }).first();
            await hoverAndClick(ancestorRowGroup, multiDiffIcon);

            // Wait for Multi-File Diff View to appear
            const tabList = page.locator('.tabs-and-actions-container');
            await expect(tabList).toContainText('ancestor change');

            // Wait for the diff editor inside the view
            await page.waitForSelector('.monaco-diff-editor');
            
            // Find the editor for f1.txt's right side
            const firstRightEditor = page.locator('.monaco-diff-editor .editor.modified').first();
            await firstRightEditor.click();
            
            // Navigate out of readonly and type new text
            await page.keyboard.press('Control+A');
            await page.keyboard.insertText('edited from multi-diff');
            await page.keyboard.press('Control+S');

            // Ensure the ancestor commit was mutated with the diff edits
            await expect(async () => {
                const f1Content = repo.getFileContent(commits['ancestor'].changeId, 'f1.txt');
                expect(f1Content.trim()).toBe('edited from multi-diff');
            }).toPass({ timeout: 5000 });

        } finally {
            await app.close();
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            repo.dispose();
        }
    });
});
