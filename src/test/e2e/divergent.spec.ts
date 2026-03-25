/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ElectronApplication, type Frame } from 'playwright';
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import { TestRepo } from '../test-repo';
import { launchVSCode, focusJJLog, getLogWebview, triggerRefresh, hoverAndClick } from './e2e-helpers';

/**
 * Finds the webview frame containing the Commit Details panel.
 * Reused from commit-details.spec.ts
 */
async function getDetailsWebview(page: Page): Promise<Frame> {
    const findFrame = async (frames: ReadonlyArray<Frame>): Promise<Frame | undefined> => {
        for (const f of frames) {
            try {
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

    await expect(guestFrame!.locator('textarea')).toBeVisible({ timeout: 10000 });
    return guestFrame!;
}

test.describe('Divergent Commits E2E', () => {
    let repo: TestRepo;
    let app: ElectronApplication;
    let page: Page;
    let userDataDir: string;

    test.beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        // 1. Create a commit (A version 1)
        repo.writeFile('a.txt', 'content a');
        repo.describe('commit A v1');
        const commitIdV1 = repo.getCommitId('@');

        // 2. Edit the message (creates A version 2)
        repo.describe('commit A v2');

        // 3. Bookmark the old version to make it visible, creating divergence
        repo.bookmark('zombie', commitIdV1);

        const setup = await launchVSCode(repo);
        app = setup.app;
        page = setup.page;
        userDataDir = setup.userDataDir;

        await focusJJLog(page);
    });

    test.afterEach(async () => {
        if (app) await app.close();
        if (userDataDir) {
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
        }
        if (repo) repo.dispose();
    });

    test('Visualizes divergence and allows resolving it', async () => {
        const webview = await getLogWebview(page);

        // 1. Verify graph visuals
        // Both A v1 (zombie) and A v2 (@) should be visible
        const rowV1 = webview.locator('.commit-row', { hasText: 'commit A v1' });
        const rowV2 = webview.locator('.commit-row', { hasText: 'commit A v2' });

        await expect(rowV1).toBeVisible();
        await expect(rowV2).toBeVisible();

        // Verify purple suffix in graph for both
        const suffix1 = rowV1.locator('.commit-id').locator('span', { hasText: /\/[012]/ });
        const suffix2 = rowV2.locator('.commit-id').locator('span', { hasText: /\/[012]/ });

        await expect(suffix1).toBeVisible();
        await expect(suffix2).toBeVisible();

        // Verify the (divergent) label is also visible in the description area
        await expect(rowV1.getByText('(divergent)')).toBeVisible();
        await expect(rowV2.getByText('(divergent)')).toBeVisible();

        // 2. Verify Tab Title for A v2
        await rowV2.click();

        const changeIdV2 = await rowV2.getAttribute('data-change-id'); // e.g. "uuid/0" or "uuid/1"
        const [uuid, offset] = changeIdV2!.split('/');
        const shortId = uuid.substring(0, 3);

        // Big Solidus is \u29F8
        const tabTitle = `Commit: ${shortId}\u29F8${offset}`;
        await expect(page.getByRole('tab', { name: tabTitle })).toBeVisible({
            timeout: 15000,
        });

        // 3. Edit Description for A v2
        const details = await getDetailsWebview(page);
        const textarea = details.locator('textarea');
        await textarea.fill('updated A v2 message');

        const saveButton = details.locator('button', { hasText: /Save Changes/ });
        await saveButton.click();

        // Wait for it to save
        await expect(details.locator('button', { hasText: 'Saved' })).toBeDisabled({ timeout: 15000 });

        // Verify in repo
        const desc2 = repo.getDescription(changeIdV2!);
        expect(desc2).toBe('updated A v2 message');

        // 4. Abandon the "zombie" commit (A v1) to resolve divergence
        await focusJJLog(page);

        // Re-get webview because focus might refresh it
        const webview2 = await getLogWebview(page);
        const rowToAbandon = webview2.locator('.commit-row', { hasText: 'commit A v1' });

        await expect(rowToAbandon).toBeVisible();
        await hoverAndClick(rowToAbandon, webview2.locator('.icon-button[title="Abandon Commit"]'));

        // 5. Verify divergence is resolved
        await expect(async () => {
            // Trigger refresh to ensure the backend update is picked up synchronously in the test
            await triggerRefresh(page);

            const finalWebview = await getLogWebview(page);
            const remainingRows = finalWebview.locator('.commit-row', { hasText: 'updated A v2 message' });
            await expect(remainingRows).toHaveCount(1);

            // Should NO LONGER have a slash in the ID area
            const idArea = remainingRows.locator('.commit-id');
            await expect(idArea.locator('span', { hasText: '/' })).toBeHidden();

            // Should NO LONGER have the (divergent) label
            await expect(remainingRows.getByText('(divergent)')).toBeHidden();
        }).toPass({ timeout: 20000 });
    });
});
