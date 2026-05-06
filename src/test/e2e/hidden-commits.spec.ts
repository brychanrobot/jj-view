/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { focusJJLog, getLogWebview, launchVSCode } from './e2e-helpers';

test.describe('Hidden Commits', () => {
    let repo: TestRepo;

    test.beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
    });

    test.afterEach(async () => {
        repo.dispose();
    });

    test('renders a ghost shape for hidden commit nodes', async () => {
        // 1. Create a commit that we will hide
        repo.new([], 'ghost commit');
        const ghostCommitId = repo.getCommitId('@');

        // 2. Abandon it to make it hidden
        repo.abandon('@');

        // 3. Configure jj to show this hidden commit by including its ID in revsets.log
        // We include it explicitly so it shows up in the graph.
        const revset = `commit_id(${ghostCommitId.substring(0, 8)}) | present(@) | ancestors(immutable_heads().., 2) | trunk()`;
        repo.config('revsets.log', revset);

        const { page } = await launchVSCode(repo);

        await focusJJLog(page);
        const webview = await getLogWebview(page);

        // 4. Verify the hidden commit is in the log text (to ensure it's loaded)
        const ghostRow = webview.locator('.commit-row', { hasText: 'ghost commit' });
        await expect(ghostRow).toBeVisible({ timeout: 10000 });

        // 5. Verify the graph node is a ghost using our data attribute
        const ghostPath = webview.locator('path[data-ghost="true"]');
        await expect(ghostPath).toBeVisible();
    });
});
