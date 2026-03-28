/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import { TestRepo, buildGraph } from '../test-repo';
import { focusJJLog, getLogWebview, launchVSCode } from './e2e-helpers';

test.describe('Workspace Labels E2E', () => {
    test('Shows workspace labels for multiple workspaces', async () => {
        const repo = new TestRepo();
        repo.init();

        // Setup a repo with two commits
        const nodes = await buildGraph(repo, [
            { label: 'base', description: 'base commit' },
            { label: 'other', description: 'other commit' },
        ]);

        const baseId = nodes['base'].changeId;
        const otherId = nodes['other'].changeId;

        const workspaceName = 'repo2';
        repo.workspaceAdd(workspaceName, baseId);

        const { app, page, userDataDir } = await launchVSCode(repo);

        try {
            await focusJJLog(page);
            const webview = await getLogWebview(page);

            // The default workspace label is 'default@'
            await expect(webview.locator('.bookmark-pill', { hasText: 'default@' })).toBeVisible();

            // The secondary workspace label should match our workspace name
            await expect(webview.locator('.bookmark-pill', { hasText: workspaceName })).toBeVisible();

            // 'default@' should be on the 'other' commit
            const otherRow = webview.locator(`[data-change-id="${otherId}"]`);
            await expect(otherRow.locator('.bookmark-pill', { hasText: 'default@' })).toBeVisible();

            // 'repo2@' should be on its own working copy (created by workspace add)
            const repo2Pill = webview.locator('.bookmark-pill', { hasText: new RegExp(`${workspaceName}.*@`) });
            await expect(repo2Pill).toBeVisible();
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
