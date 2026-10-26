/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, type Page } from '@playwright/test';
import { buildGraph, type CommitId, TestRepo } from '../test-repo';
import { clearActiveEditor, clickScmAction, focusSCM, SCM_ACTIONS, test, waitForTab } from './e2e-helpers';
import type { VSCodeFixture } from './vscode-fixture';

async function setSquashEditorText(page: Page, text: string, vscode: VSCodeFixture) {
    const editor = page.locator('.editor-instance .monaco-editor').first();
    await expect(editor).toBeVisible({ timeout: 5000 });
    await expect(editor.locator('.view-lines')).toContainText(/parent\s+description/, {
        timeout: 5000,
    });

    const textRegex = new RegExp(text.trim().split(/\s+/).join('\\s+'));
    await expect(async () => {
        await editor.locator('.view-lines').click();
        await clearActiveEditor(page);
        await page.keyboard.insertText(text);
        await expect(editor.locator('.view-lines')).toContainText(textRegex, { timeout: 1000 });
        await expect(editor.locator('.view-lines')).not.toContainText(/parent\s+description/, { timeout: 1000 });

        const isSynced = await vscode.evaluate((vsc, _api, expected) => {
            const doc = vsc.window.activeTextEditor?.document;
            return Boolean(
                doc?.uri.fsPath.endsWith('SQUASH_MSG') &&
                    doc.isDirty &&
                    doc.getText().trim() === (expected as string).trim(),
            );
        }, text);
        expect(isSynced).toBe(true);
    }).toPass({ timeout: 5000, intervals: [100, 250, 500] });
}

test.describe('Squash E2E', () => {
    let repo: TestRepo;
    let page: Page;
    let ids: Record<string, CommitId>;

    test.beforeEach(async ({ vscode }) => {
        repo = new TestRepo();
        repo.init();
        ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent description' },
            { label: 'child', parents: ['parent'], description: 'child description', files: { 'f.txt': 'content' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        const setup = await vscode.openWorkspace(repo, {}, {}, true);
        page = setup.page;
    });

    test.afterEach(async () => {
        if (repo) {
        }
    });

    test('Squash: Save and Close', async ({ vscode }) => {
        await focusSCM(page);

        // Trigger squash. Since both have descriptions, it should open the editor.
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Find the editor and modify the text
        await setSquashEditorText(page, 'Combined Description', vscode);

        // Clear any active notifications first
        await vscode.executeCommand('notifications.clearAll');

        // Close the tab and handle the "Save changes?" dialog
        await vscode.executeCommandWithSaveDialog('workbench.action.closeActiveEditor', 'Save');

        // Verify the squash is completed in jj
        await expect(async () => {
            const log = repo.log();
            const desc = repo.getDescription(ids.parent.changeId);
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            expect(desc).toBe('Combined Description');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed automatically
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible({ timeout: 5000 });
    });

    test('Squash: Finalize via checkmark button', async ({ vscode }) => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Find the editor and modify the text
        await setSquashEditorText(page, 'Description via Button', vscode);

        // Click the checkmark button in the editor title bar
        const completeButton = page.getByRole('button', { name: 'Complete Squash Revision' }).first();
        await completeButton.click();

        // Verify the squash is completed in jj
        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            const desc = repo.getDescription(ids.parent.changeId);
            expect(desc).toBe('Description via Button');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed automatically
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible({ timeout: 5000 });
    });

    test('Squash: Close without saving (unmodified)', async ({ vscode }) => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Clear notifications
        await vscode.executeCommand('notifications.clearAll');

        // Close the tab without modifying it via VS Code command
        await vscode.executeCommand('workbench.action.closeActiveEditor');

        // Verify the squash is completed with the original combined description
        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            const desc = repo.getDescription(ids.parent.changeId);
            expect(desc).toBe('parent description\n\nchild description');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible();
    });

    test("Squash: Close without saving (modified, click Don't Save)", async ({ vscode }) => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Find the editor and modify the text
        await setSquashEditorText(page, 'Description via Dialog', vscode);

        // Clear notifications
        await vscode.executeCommand('notifications.clearAll');

        // Close the tab and handle the "Save changes?" dialog
        await vscode.executeCommandWithSaveDialog('workbench.action.closeActiveEditor', "Don't Save");

        // Verify the squash is completed in jj, but since we didn't save, it uses the original disk contents
        await expect(async () => {
            const log = repo.log();
            expect(log).not.toContain(ids.child.changeId.substring(0, 8));
            const desc = repo.getDescription(ids.parent.changeId);
            expect(desc).toBe('parent description\n\nchild description');
        }).toPass({ timeout: 10000 });

        // Verify the tab is closed
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).not.toBeVisible();
    });

    test('Squash: Close without saving (modified, click Cancel)', async ({ vscode }) => {
        await focusSCM(page);

        // Trigger squash
        await clickScmAction(page, /child description/, SCM_ACTIONS.SquashRevisionIntoParent);

        // Wait for SQUASH_MSG tab to open
        await waitForTab(page, 'SQUASH_MSG');

        // Modify the text to make it dirty
        await setSquashEditorText(page, 'Some text', vscode);

        // Clear notifications
        await vscode.executeCommand('notifications.clearAll');

        // Close the tab and handle the "Save changes?" dialog
        await vscode.executeCommandWithSaveDialog('workbench.action.closeActiveEditor', 'Cancel');

        // Verify the squash was NOT completed, since the tab is still open
        await expect(async () => {
            const log = repo.log();
            expect(log).toContain('child description');
        }).toPass({ timeout: 5000 });

        // Verify the tab is STILL open because we canceled the close
        const tab = page.getByRole('tab', { name: 'SQUASH_MSG' });
        await expect(tab).toBeVisible();
    });
});
