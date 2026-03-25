/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ElectronApplication, type Frame } from 'playwright';
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import { TestRepo, buildGraph, type CommitId } from '../test-repo';
import { launchVSCode, focusJJLog, getLogWebview, undo, redo, save } from './e2e-helpers';

/**
 * Finds the webview frame containing the Commit Details panel.
 */
async function getDetailsWebview(page: Page): Promise<Frame> {
    const findFrame = async (frames: ReadonlyArray<Frame>): Promise<Frame | undefined> => {
        for (const f of frames) {
            try {
                // Return the first iframe that is actually visible (not hidden by VS Code's tab switching)
                // We consider it the active webview if its textarea is visible, meaning it's the actively displayed tab
                if (await f.locator('textarea').isVisible({ timeout: 50 })) {
                    return f;
                }

                const nested = await findFrame(f.childFrames());
                if (nested) return nested;
            } catch (e) {}
        }
        return undefined;
    };

    let guestFrame: Frame | undefined;
    await expect
        .poll(
            async () => {
                guestFrame = await findFrame(page.frames());
                return guestFrame;
            },
            {
                timeout: 30000,
                message: 'Could not find Commit Details webview frame',
            },
        )
        .toBeDefined();

    // Ensure the iframe is fully "ready" before returning
    await expect(guestFrame!.locator('textarea')).toBeVisible({ timeout: 10000 });
    return guestFrame!;
}

test.describe('Commit Details E2E', () => {
    let repo: TestRepo;
    let app: ElectronApplication;
    let page: Page;
    let userDataDir: string;
    let nodes: Record<string, CommitId>;

    test.beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        nodes = await buildGraph(repo, [
            {
                label: 'initial',
                description: 'initial setup',
                files: { 'f.txt': 'base content', 'g.txt': 'other content' },
            },
            {
                label: 'feature',
                parents: ['initial'],
                description: 'add feature',
                files: { 'f.txt': 'modified content' },
            },
            {
                label: 'empty-commit',
                parents: ['initial'],
                description: 'empty and tagged',
                tags: ['test-e2e-tag'],
            },
            {
                label: 'conflict-1',
                parents: ['initial'],
                files: { 'f.txt': 'conflict 1' },
            },
            {
                label: 'conflict-2',
                parents: ['initial'],
                files: { 'f.txt': 'conflict 2' },
            },
            {
                label: 'conflicted-commit',
                parents: ['conflict-1', 'conflict-2'],
                description: 'conflicted commit',
            },
        ]);

        const setup = await launchVSCode(repo);
        app = setup.app;
        page = setup.page;
        userDataDir = setup.userDataDir;

        await focusJJLog(page);
    });

    test.afterEach(async () => {
        if (app) await app.close();
        if (userDataDir)
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
        if (repo) repo.dispose();
    });

    test('Opens with correct ID, description, and file list', async () => {
        const webview = await getLogWebview(page);
        const initialRow = webview.locator('.commit-row', { hasText: 'initial setup' });

        // Click the commit to open details panel
        await initialRow.click();

        // Wait for the details panel tab to appear
        const shortId = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        // Find the details webview
        const details = await getDetailsWebview(page);

        // Verify change ID is displayed in full (32 chars)
        const changeIdDiv = details
            .locator('div')
            .filter({ has: details.getByText('Change:', { exact: true }) })
            .last();
        const changeIdSpan = changeIdDiv.locator('span[title]').first();
        const idText = await changeIdSpan.textContent();
        expect(idText).toContain(nodes['initial'].changeId);
        expect(nodes['initial'].changeId.length).toBe(32);

        // Verify description is shown in the textarea (ignore trailing newlines)
        const textarea = details.locator('textarea');
        await expect(textarea).toHaveValue(/initial setup/);

        // Verify file list shows the correct files
        // 'initial' commit has f.txt (added) and g.txt (added)
        await expect(details.locator('text=f.txt')).toBeVisible();
        await expect(details.locator('text=g.txt')).toBeVisible();

        // Verify the "Changed Files" count label
        await expect(details.locator('text=Changed Files (2)')).toBeVisible();
    });

    test('Save description via button', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });

        // Click to open details
        await featureRow.click();

        const shortId = nodes['feature'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);

        // the button initially says "Saved" and is disabled
        const saveButton = details.locator('button', { hasText: /^Saved/ });
        await expect(saveButton).toBeDisabled();

        // Edit the description
        const textarea = details.locator('textarea');
        await textarea.fill('updated feature description');

        // Verify dirty indicator logic
        const saveChangesButton = details.locator('button', { hasText: /Save Changes|Saved/ });
        await expect(saveChangesButton).toBeEnabled();
        await expect(page.locator('.tab', { hasText: new RegExp(`^Commit: ${shortId}`) })).toHaveClass(/dirty/);

        // Click Save
        await saveChangesButton.click();

        // Verify the Save button is disabled (via our Webview state checking it's clean)
        await expect(saveChangesButton).toBeDisabled({ timeout: 15000 });

        // Verify the description was saved in the repo
        await expect(async () => {
            const desc = repo.getDescription(nodes['feature'].changeId);
            expect(desc).toBe('updated feature description');
        }).toPass({ timeout: 10000 });
    });

    test('Save description via Ctrl+S', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });

        // Click to open details
        await featureRow.click();

        const shortId = nodes['feature'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);

        // Edit the description
        const textarea = details.locator('textarea');
        await textarea.fill('saved via keyboard');

        // Verify dirty state
        await expect(page.locator('.tab', { hasText: new RegExp(`^Commit: ${shortId}`) })).toHaveClass(/dirty/);

        // Focus the textarea and press Save
        await textarea.focus();
        await save(page);

        // Verify the Save button is disabled (via our Webview state checking it's clean)
        const saveChangesButton = details.locator('button', { hasText: /Save Changes|Saved/ });
        await expect(saveChangesButton).toBeDisabled({ timeout: 15000 });

        // Verify the description was saved in the repo
        await expect(async () => {
            const desc = repo.getDescription(nodes['feature'].changeId);
            expect(desc).toBe('saved via keyboard');
        }).toPass({ timeout: 10000 });
    });

    test('Dirty indicator works when starting from an empty message', async () => {
        // Create a new empty commit using the CLI directly
        repo.new([nodes['initial'].changeId]);
        const newCommitId = repo.getChangeId('@');

        // Wait for the file watcher to detect the change and refresh the graph.
        await page.waitForTimeout(1000);

        // Refresh the webview by focusing it to pick up graph updates
        await focusJJLog(page);

        const webview = await getLogWebview(page);

        // The new commit should be visible and have (no description)
        const emptyRow = webview.locator('.commit-row', { hasText: '(no description)' }).first();

        // Click to open details
        await expect(emptyRow).toBeVisible({ timeout: 15000 });
        await emptyRow.click();

        const shortId = newCommitId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);

        // Edit the description
        const textarea = details.locator('textarea');
        await expect(textarea).toHaveValue('');

        await textarea.fill('brand new message');

        // Verify dirty state
        await expect(page.locator('.tab', { hasText: new RegExp(`^Commit: ${shortId}`) })).toHaveClass(/dirty/);
        const saveChangesButton = details.locator('button', { hasText: /Save Changes/ });
        await expect(saveChangesButton).toBeEnabled();

        // Click Save
        await saveChangesButton.click();

        // Verify the Save button is disabled (via our Webview state checking it's clean)
        await expect(details.locator('button', { hasText: 'Saved' })).toBeDisabled({ timeout: 15000 });
        await expect(page.locator('.tab', { hasText: new RegExp(`^Commit: ${shortId}`) })).not.toHaveClass(/dirty/);

        // Verify the description was saved in the repo
        await expect(async () => {
            const desc = repo.getDescription(newCommitId);
            expect(desc).toBe('brand new message');
        }).toPass({ timeout: 10000 });
    });

    test('Open file diff from file list', async () => {
        const webview = await getLogWebview(page);
        const initialRow = webview.locator('.commit-row', { hasText: 'initial setup' });

        // Click to open details
        await initialRow.click();

        const shortId = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);

        // Click on a file in the list to open a diff
        const fileRow = details.locator('text=f.txt').first();
        await fileRow.click();

        // A diff tab should open with the filename
        await expect(page.getByRole('tab', { name: /f\.txt/ })).toBeVisible({ timeout: 10000 });
    });

    test('Open Multi-File Diff from button', async () => {
        const webview = await getLogWebview(page);
        const initialRow = webview.locator('.commit-row', { hasText: 'initial setup' });

        // Click to open details
        await initialRow.click();

        const shortId = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);

        // Click the Multi-file Diff button
        const multiDiffButton = details.locator('button', { hasText: 'Multi-file Diff' });
        await multiDiffButton.click();

        // A multi-file diff tab should open with the change ID prefix
        await expect(page.getByRole('tab', { name: new RegExp(`^${shortId}`) })).toBeVisible({ timeout: 10000 });
    });

    test('Panel updates when clicking different commit', async () => {
        const webview = await getLogWebview(page);

        // Open details for 'initial'
        const initialRow = webview.locator('.commit-row', { hasText: 'initial setup' });
        await initialRow.click();
        const shortId1 = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId1}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);
        await expect(details.locator('textarea')).toHaveValue(/initial setup/);

        // Now click 'feature' — panel should update in-place (same webview, new content)
        // Need to focus the JJ Log webview again first
        await focusJJLog(page);
        // Re-get the webview after focus since frames can be invalidated
        const webview2 = await getLogWebview(page);
        const featureRow = webview2.locator('.commit-row', { hasText: 'add feature' });
        await featureRow.click();
        const shortId2 = nodes['feature'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId2}`) })).toBeVisible({
            timeout: 15000,
        });

        // The panel is reused — wait for the textarea content to update within the SAME frame
        await expect(async () => {
            const detailsFrame = await getDetailsWebview(page);
            await expect(detailsFrame.locator('textarea')).toHaveValue(/add feature/, { timeout: 2000 });
        }).toPass({ timeout: 15000 });
    });

    test('Panel auto-updates when commit description is changed externally', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });

        // Click to open details
        await featureRow.click();

        const shortId = nodes['feature'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);

        // Verify description is shown in the textarea
        const textarea = details.locator('textarea');
        await expect(textarea).toHaveValue(/add feature/);

        // Change the description externally using jj CLI
        repo.describe('externally updated description', nodes['feature'].changeId);

        // Verify the details panel updates automatically (eventually, as file watcher triggers refresh)
        // Wait up to 15s since file-watchers and graph rebuilds can take a moment
        await expect(textarea).toHaveValue(/externally updated description/, { timeout: 15000 });
    });

    test('Panel auto-closes when commit is abandoned', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });

        // Click to open details
        await featureRow.click();

        const shortId = nodes['feature'].changeId.substring(0, 3);
        const tabLocator = page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) });

        await expect(tabLocator).toBeVisible({
            timeout: 15000,
        });

        // Abandon the commit externally
        repo.abandon(nodes['feature'].changeId);

        // Verify the details panel closes automatically
        await expect(tabLocator).toBeHidden({ timeout: 15000 });
    });

    test('Format Body button rewraps text while preserving title separation', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });

        // Click to open details
        await featureRow.click();

        const details = await getDetailsWebview(page);
        const textarea = details.locator('textarea');

        // Input a long body line separated by a newline
        const longText =
            'This is a very long text that will definitely exceed the standard seventy-two character limit that is expected of most commit bodies.';
        const originalDesc = `Feature Title\n\n${longText}`;
        await textarea.fill(originalDesc);

        // Click the Format Body button
        const formatButton = details.locator('button', { hasText: 'Format Body' });
        await formatButton.click();

        // Check if the textarea content got wrapped
        const newValue = await textarea.inputValue();
        expect(newValue).not.toBe(originalDesc);
        expect(newValue).toContain(
            'Feature Title\n\nThis is a very long text that will definitely exceed the standard',
        );
        expect(newValue.split('\n').length).toBeGreaterThan(3); // Should be wrapped onto 3rd and 4th lines
    });

    test('Settings gear opens VS Code settings for jj-view.commit', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });

        // Click to open details
        await featureRow.click();
        const details = await getDetailsWebview(page);

        // Click the gear icon link
        const settingsLink = details.locator('a[title="Configure width rulers"]');
        await settingsLink.click();

        // The VS Code Settings tab should open
        await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible({ timeout: 15000 });

        // Also verify the settings are actually filtered and showing our custom setting
        // And check their default values (50 and 72)
        const titleInput = page.locator('.setting-item').filter({ hasText: 'Title Width Ruler' }).locator('input');
        await expect(titleInput).toHaveValue('50');

        const bodyInput = page.locator('.setting-item').filter({ hasText: 'Body Width Ruler' }).locator('input');
        await expect(bodyInput).toHaveValue('72');
    });

    test('Displays pills and person info correctly', async () => {
        // Configure 'initial' to be immutable using its exact commit ID
        repo.config('revset-aliases."immutable_heads()"', `commit_id("${nodes['initial'].commitId}")`);

        // Wait for the file watcher to detect the change and refresh the graph.
        await page.waitForTimeout(1000);

        // Refresh the webview by focusing it to pick up graph updates
        await focusJJLog(page);

        const webview = await getLogWebview(page);

        // 1. Check Empty and Tag pill, Author, Committer
        const emptyRow = webview.locator('.commit-row', { hasText: 'empty and tagged' });
        await expect(emptyRow).toBeVisible({ timeout: 15000 });
        await emptyRow.click();
        const details1 = await getDetailsWebview(page);

        await expect(details1.getByText('Empty', { exact: true })).toBeVisible();
        await expect(details1.getByText('test-e2e-tag', { exact: true })).toBeVisible();

        // Check Author and Committer info are rendered
        await expect(details1.getByText('Author:', { exact: true })).toBeVisible();
        await expect(details1.getByText('Committer:', { exact: true })).toBeVisible();
        await expect(details1.locator('strong', { hasText: 'Test User' })).toHaveCount(2);
        await expect(details1.locator('span', { hasText: '<test@example.com>' })).toHaveCount(2);

        // 3. Check Immutable pill
        // Click another commit then click back to force the panel to fetch the latest state
        await webview.locator('.commit-row', { hasText: 'add feature' }).click();
        await page.waitForTimeout(500);
        await focusJJLog(page);

        const currentWebview = await getLogWebview(page);
        const initialRow = currentWebview.locator('.commit-row', { hasText: 'initial setup' });

        // Click once to open the panel
        await initialRow.click();

        await expect(async () => {
            // Fetch the details frame dynamically because it may detach and recreate if the extension
            // reloads the webview during a background refresh
            const frame = await getDetailsWebview(page);
            await expect(frame.getByTitle('This commit cannot be modified')).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 20000 });
    });

    test('Prompts to save when closing a dirty details panel', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });

        // Click to open details
        await featureRow.click();

        const shortId = nodes['feature'].changeId.substring(0, 3);
        const tabLocator = page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) });
        await expect(tabLocator).toBeVisible({ timeout: 15000 });

        const details = await getDetailsWebview(page);
        const textarea = details.locator('textarea');
        await textarea.fill('updated via test before close');

        // Verify dirty indicator logic to make sure the state is registered
        const saveChangesButton = details.locator('button', { hasText: /Save Changes \((⌘|Ctrl\+)S\)/ });
        await expect(saveChangesButton).toBeEnabled();
        await expect(page.locator('.tab', { hasText: new RegExp(`^Commit: ${shortId}`) })).toHaveClass(/dirty/);

        // Close the tab using the tab close button
        const tabCloseButton = tabLocator.getByRole('button', { name: 'Close' });
        await tabCloseButton.click();

        // Wait for the native VS Code dialog (which is now rendered as custom HTML by our settings)
        const dialog = page.locator('.monaco-dialog-box');
        await expect(dialog).toBeVisible({ timeout: 5000 });

        // Click "Save"
        const saveDialogButton = dialog.getByRole('button', { name: 'Save', exact: true });
        await saveDialogButton.click();

        // Verify the description was saved in the repo
        await expect(async () => {
            const desc = repo.getDescription(nodes['feature'].changeId);
            expect(desc).toBe('updated via test before close');
        }).toPass({ timeout: 10000 });

        // Verify the node is no longer selected in the graph
        const updatedFeatureRow = webview.locator('.commit-row', { hasText: 'updated via test before close' });
        await expect(updatedFeatureRow).toHaveAttribute('aria-selected', 'false', { timeout: 10000 });
    });

    test('Hides buttons and disables editor for immutable commits', async () => {
        // Configure 'initial' to be immutable
        repo.config('revset-aliases."immutable_heads()"', `commit_id("${nodes['initial'].commitId}")`);
        await focusJJLog(page);

        const webview = await getLogWebview(page);
        const initialRow = webview.locator('.commit-row', { hasText: 'initial setup' });

        // Click to open details
        await initialRow.click();
        const shortId = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({
            timeout: 15000,
        });

        const details = await getDetailsWebview(page);

        // Verify textarea is disabled
        const textarea = details.locator('textarea');
        await expect(textarea).toBeDisabled();

        // Verify buttons are hidden
        const saveChangesButton = details.locator('button', { hasText: /Save Changes|Saved/ });
        await expect(saveChangesButton).toBeHidden();

        const formatButton = details.locator('button', { hasText: 'Format Body' });
        await expect(formatButton).toBeHidden();
    });

    test('Undo/Redo integration with VS Code', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });
        await featureRow.click();

        const shortId = nodes['feature'].changeId.substring(0, 3);
        const tabLocator = page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) });
        await expect(tabLocator).toBeVisible({ timeout: 15000 });

        const details = await getDetailsWebview(page);
        const textarea = details.locator('textarea');

        // Stage 1: First edit
        await textarea.focus();
        await page.keyboard.press('End');
        await page.keyboard.type(' first');
        // Wait for debounce (200ms) plus buffer to ensure VS Code registers the edit.
        await page.waitForTimeout(500);
        await expect(tabLocator).toHaveClass(/dirty/);
        await expect(textarea).toHaveValue('add feature first');

        // Stage 2: Second edit
        await page.keyboard.type(' second');
        await page.waitForTimeout(500);
        await expect(textarea).toHaveValue('add feature first second');

        // Stage 3: Undo once
        await undo(page);
        await expect(textarea).toHaveValue('add feature first');
        await expect(tabLocator).toHaveClass(/dirty/);

        // Stage 4: Undo again
        await undo(page);
        await expect(textarea).toHaveValue('add feature');
        // It should no longer be dirty because we are back to persisted state (and VS Code knows this sequence)
        await expect(tabLocator).not.toHaveClass(/dirty/);

        // Stage 5: Redo
        await redo(page);
        await expect(textarea).toHaveValue('add feature first');
        await expect(tabLocator).toHaveClass(/dirty/);
    });

    test('Stealth Save: Dirty state clears when manually returning to original state', async () => {
        const webview = await getLogWebview(page);
        const featureRow = webview.locator('.commit-row', { hasText: 'add feature' });
        await featureRow.click();

        const shortId = nodes['feature'].changeId.substring(0, 3);
        const tabLocator = page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) });
        await expect(tabLocator).toBeVisible({ timeout: 15000 });

        const details = await getDetailsWebview(page);
        const textarea = details.locator('textarea');

        // 1. Make an edit to make it dirty
        await textarea.fill('add feature (edited)');
        // Wait for debounce and dirty indicator
        await expect(async () => {
            await expect(tabLocator).toHaveClass(/dirty/);
        }).toPass({ timeout: 5000 });

        // 2. Manually revert the change to the original text
        await textarea.fill('add feature');

        // 3. Verify it clears within the debounce window
        await expect(async () => {
            await expect(tabLocator).not.toHaveClass(/dirty/);
        }).toPass({ timeout: 5000 });
    });
});
