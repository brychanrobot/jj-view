/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ElectronApplication, type Frame } from 'playwright';
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import { TestRepo, buildGraph, type CommitId } from '../test-repo';
import { launchVSCode, focusJJLog, getLogWebview } from './e2e-helpers';

/**
 * Finds the webview frame containing the Commit Details panel.
 */
async function getDetailsWebview(page: Page): Promise<Frame> {
    const findFrame = async (frames: ReadonlyArray<Frame>): Promise<Frame | undefined> => {
        for (const f of frames) {
            try {
                // First check if the frame itself is valid and has a heading
                // We don't want to use count() > 0 which can be slow; use visible check
                const heading = f.locator('h2', { hasText: 'Commit Details' });
                if (await heading.isVisible({ timeout: 500 })) {
                    return f;
                }
                
                const nested = await findFrame(f.childFrames());
                if (nested) return nested;
            } catch (e) {}
        }
        return undefined;
    };

    let guestFrame: Frame | undefined;
    await expect.poll(async () => {
        guestFrame = await findFrame(page.frames());
        return guestFrame;
    }, {
        timeout: 30000,
        message: 'Could not find Commit Details webview frame'
    }).toBeDefined();

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
            { label: 'initial', description: 'initial setup', files: { 'f.txt': 'base content', 'g.txt': 'other content' } },
            { label: 'feature', parents: ['initial'], description: 'add feature', files: { 'f.txt': 'modified content' } },
        ]);

        const setup = await launchVSCode(repo);
        app = setup.app;
        page = setup.page;
        userDataDir = setup.userDataDir;

        await focusJJLog(page);
    });

    test.afterEach(async () => {
        if (app) await app.close();
        if (userDataDir) try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
        if (repo) repo.dispose();
    });

    test('Opens with correct ID, description, and file list', async () => {
        const webview = await getLogWebview(page);
        const initialRow = webview.locator('.commit-row', { hasText: 'initial setup' });

        // Click the commit to open details panel
        await initialRow.click();

        // Wait for the details panel tab to appear
        const shortId = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({ timeout: 15000 });

        // Find the details webview
        const details = await getDetailsWebview(page);

        // Verify change ID is displayed in full (32 chars)
        const idText = await details.locator('div[title]').first().textContent();
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
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({ timeout: 15000 });

        const details = await getDetailsWebview(page);

        // Edit the description
        const textarea = details.locator('textarea');
        await textarea.fill('updated feature description');

        // Click Save
        const saveButton = details.locator('button', { hasText: 'Save Description' });
        await saveButton.click();

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
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({ timeout: 15000 });

        const details = await getDetailsWebview(page);

        // Edit the description
        const textarea = details.locator('textarea');
        await textarea.fill('saved via keyboard');

        // Focus the textarea and press Ctrl+S
        await textarea.focus();
        await page.keyboard.press('Control+s');

        // Verify the description was saved in the repo
        await expect(async () => {
            const desc = repo.getDescription(nodes['feature'].changeId);
            expect(desc).toBe('saved via keyboard');
        }).toPass({ timeout: 10000 });
    });

    test('Open file diff from file list', async () => {
        const webview = await getLogWebview(page);
        const initialRow = webview.locator('.commit-row', { hasText: 'initial setup' });

        // Click to open details
        await initialRow.click();

        const shortId = nodes['initial'].changeId.substring(0, 3);
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({ timeout: 15000 });

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
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId}`) })).toBeVisible({ timeout: 15000 });

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
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId1}`) })).toBeVisible({ timeout: 15000 });

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
        await expect(page.getByRole('tab', { name: new RegExp(`^Commit: ${shortId2}`) })).toBeVisible({ timeout: 15000 });

        // The panel is reused — wait for the textarea content to update within the SAME frame
        await expect(async () => {
            const detailsFrame = await getDetailsWebview(page);
            await expect(detailsFrame.locator('textarea')).toHaveValue(/add feature/, { timeout: 2000 });
        }).toPass({ timeout: 15000 });
    });
});
