/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { FakeGitLabServer } from '../helpers/fake-gitlab-server';
import { buildGraph, type CommitDefinition, TestRepo } from '../test-repo';
import {
    expectBadgeLink,
    expectNotificationToast,
    focusJJLog,
    focusSCM,
    launchVSCode,
    locateQuickInputItem,
    locateQuickInputWidget,
    maybePrintExtensionLogs,
    pickQuickPickItem,
    waitForLogCommitRow,
    waitForQuickInput,
} from './e2e-helpers';

test.describe('GitLab Integration E2E', () => {
    let gitlab: FakeGitLabServer;

    test.beforeAll(async () => {
        gitlab = new FakeGitLabServer();
        await gitlab.start();
    });

    test.afterAll(async () => {
        await gitlab.stop();
    });

    test.beforeEach(() => {
        gitlab.clearRequests();
    });

    test('Detects GitLab MR status via bookmark', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://gitlab.com/test-owner/test-repo.git');

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'mr-commit', parents: ['base'], description: 'MR Commit', bookmarks: ['my-feature-branch'] },
        ];

        const commits = await buildGraph(repo, graph);

        gitlab.registerMR('my-feature-branch', {
            id: 123456,
            iid: 42,
            state: 'opened',
            title: 'MR Commit',
            description: 'Mock MR Commit Description',
            web_url: 'https://gitlab.com/test-owner/test-repo/-/merge_requests/42',
            draft: false,
            merge_status: 'can_be_merged',
            detailed_merge_status: 'mergeable',
            blocking_discussions_resolved: false,
            sha: commits['mr-commit'].commitId,
            user_notes_count: 3,
        });

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'gitlab',
                'jj-view.gitlab.host': gitlab.url,
            },
            {
                JJ_VIEW_GITLAB_TOKEN: 'test-token',
                JJ_VIEW_GITLAB_API_URL: gitlab.url,
            },
        );

        try {
            await focusJJLog(page);

            const row = await waitForLogCommitRow(page, 'MR Commit');

            // Verify MR label is shown with correct number and URL
            await expectBadgeLink(row, 'MR !42', 'https://gitlab.com/test-owner/test-repo/-/merge_requests/42');

            // Verify unresolved comments bubble is shown (value: 3)
            await expect(row.getByTitle('3 Unresolved Comments')).toBeVisible();

            // Since commit ID matches currentRevision, upload button should NOT be visible
            const uploadButton = row.getByRole('button', { name: 'Upload changes to GitLab' });
            await expect(uploadButton).not.toBeVisible();
        } finally {
            maybePrintExtensionLogs(userDataDir);
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Shows Upload button when content is out of sync and performs upload', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://gitlab.com/test-owner/test-repo.git');

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            {
                label: 'out-of-sync-commit',
                parents: ['base'],
                description: 'Out of Sync Commit',
                bookmarks: ['my-feature-branch-2'],
            },
        ];

        const commits = await buildGraph(repo, graph);

        // Register with mismatched revision
        gitlab.registerMR('my-feature-branch-2', {
            id: 456789,
            iid: 101,
            state: 'opened',
            title: 'Out of Sync Commit',
            description: 'Mock MR Commit Description',
            web_url: 'https://gitlab.com/test-owner/test-repo/-/merge_requests/101',
            draft: false,
            merge_status: 'can_be_merged',
            detailed_merge_status: 'mergeable',
            blocking_discussions_resolved: true,
            sha: 'different-commit-sha',
        });

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'gitlab',
                'jj-view.gitlab.host': gitlab.url,
                'jj-view.uploadCommand': 'describe -m uploaded_successfully',
            },
            {
                JJ_VIEW_GITLAB_TOKEN: 'test-token',
                JJ_VIEW_GITLAB_API_URL: gitlab.url,
            },
        );

        try {
            await focusJJLog(page);

            const row = await waitForLogCommitRow(page, 'Out of Sync Commit');

            // Verify MR label and URL
            await expectBadgeLink(row, 'MR !101', 'https://gitlab.com/test-owner/test-repo/-/merge_requests/101');

            // Verify upload button is visible
            const uploadButton = row.getByRole('button', { name: 'Upload changes to GitLab' });
            await expect(uploadButton).toBeVisible();

            // Click upload button
            await uploadButton.click();

            const changeId = commits['out-of-sync-commit'].changeId;
            await expect(async () => {
                const desc = repo.getDescription(changeId);
                expect(desc).toContain('uploaded_successfully');
            }).toPass({ timeout: 15000 });
        } finally {
            maybePrintExtensionLogs(userDataDir);
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Manages GitLab auth choices via Quick Pick', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://gitlab.com/test-owner/test-repo.git');

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'mr-commit', parents: ['base'], description: 'MR Commit', bookmarks: ['my-feature-branch'] },
        ];
        const commits = await buildGraph(repo, graph);

        gitlab.registerMR('my-feature-branch', {
            id: 123456,
            iid: 42,
            state: 'opened',
            title: 'MR Commit',
            description: 'Mock MR Commit Description',
            web_url: 'https://gitlab.com/test-owner/test-repo/-/merge_requests/42',
            draft: false,
            merge_status: 'can_be_merged',
            detailed_merge_status: 'mergeable',
            blocking_discussions_resolved: false,
            sha: commits['mr-commit'].commitId,
        });

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'gitlab',
                'jj-view.gitlab.host': gitlab.url,
            },
            {
                JJ_VIEW_GITLAB_API_URL: gitlab.url,
            },
        );

        try {
            await focusJJLog(page);
            await waitForLogCommitRow(page, 'MR Commit');

            await focusSCM(page);
            const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' });
            await scmInputRow.click();

            // Click the Manage Auth button in the Source Control title bar
            const manageAuthButton = page.getByRole('button', { name: 'Manage Code Forge Authentication' }).first();
            await expect(manageAuthButton).toBeVisible({ timeout: 15000 });
            await manageAuthButton.click();

            // Now the custom Quick Pick should be visible. Let's select "Disable Authentication Prompts"
            await pickQuickPickItem(page, /Disable Authentication Prompts/);

            // Verify confirmation message or state by checking that the quick pick closed
            const quickPick = locateQuickInputWidget(page);
            await expect(quickPick).not.toBeVisible();
        } finally {
            maybePrintExtensionLogs(userDataDir);
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Manages GitLab PAT flow via Quick Pick', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://gitlab.com/test-owner/test-repo.git');

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'gitlab',
                'jj-view.gitlab.host': gitlab.url,
            },
            {
                JJ_VIEW_GITLAB_API_URL: gitlab.url,
            },
            true, // showNotifications = true
        );

        try {
            await focusSCM(page);
            const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' });
            await scmInputRow.click();

            // Click the Manage Auth button in the Source Control title bar
            const manageAuthButton = page.getByRole('button', { name: 'Manage Code Forge Authentication' }).first();
            await expect(manageAuthButton).toBeVisible({ timeout: 15000 });
            await manageAuthButton.click();

            // Check that the items "Sign In (OAuth)" and "Enter Personal Access Token (PAT)" are present
            const quickPick = locateQuickInputWidget(page).filter({ visible: true });
            await expect(locateQuickInputItem(page, 'Enter Personal Access Token (PAT)')).toBeVisible();

            // Click "Enter Personal Access Token (PAT)"
            await pickQuickPickItem(page, 'Enter Personal Access Token');

            // Wait for the showInputBox input to appear
            const input = await waitForQuickInput(page);
            await input.focus();
            await input.fill('glpat-test-mock-token');
            await input.press('Enter');

            // Wait for input box to close
            await expect(quickPick).not.toBeVisible();

            // Re-open the Manage Auth menu
            await focusSCM(page);
            await scmInputRow.click();
            await manageAuthButton.click();
            await expect(quickPick).toBeVisible();

            // Verify "Update Personal Access Token (PAT)" and "Clear Personal Access Token (PAT)" are now visible
            await expect(locateQuickInputItem(page, 'Update Personal Access Token (PAT)')).toBeVisible();
            await expect(locateQuickInputItem(page, 'Clear Personal Access Token (PAT)')).toBeVisible();

            // Click "Clear Personal Access Token (PAT)"
            await pickQuickPickItem(page, 'Clear Personal Access Token');

            // Wait for menu to close
            await expect(quickPick).not.toBeVisible();

            // Wait for the success toast to appear, indicating the deletion is complete
            await expectNotificationToast(page, 'Successfully cleared stored GitLab Personal Access Token');

            // Re-open again to confirm it reverted back to "Enter Personal Access Token (PAT)"
            await expect(async () => {
                const isVisible = await quickPick.isVisible();
                if (isVisible) {
                    await page.keyboard.press('Escape');
                    await expect(quickPick).not.toBeVisible();
                }
                await focusSCM(page);
                await scmInputRow.click();
                await manageAuthButton.click();
                await expect(locateQuickInputItem(page, 'Enter Personal Access Token (PAT)')).toBeVisible({
                    timeout: 2000,
                });
            }).toPass({ timeout: 15000 });

            await expect(locateQuickInputItem(page, 'Clear Personal Access Token (PAT)')).not.toBeVisible();
        } finally {
            maybePrintExtensionLogs(userDataDir);
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Shows warning notification toast on 403 Forbidden scope errors', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://gitlab.com/test-owner/test-repo.git');

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'mr-commit', parents: ['base'], description: 'MR Commit', bookmarks: ['my-feature-branch'] },
        ];
        await buildGraph(repo, graph);

        // Override status on fake GitLab server to return 403 with specific scopes
        gitlab.statusOverride = {
            status: 403,
            headers: {
                'x-oauth-scopes': 'read_user, read_repository',
            },
            body: 'Forbidden',
        };

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'gitlab',
                'jj-view.gitlab.host': gitlab.url,
            },
            {
                JJ_VIEW_GITLAB_TOKEN: 'test-token',
                JJ_VIEW_GITLAB_API_URL: gitlab.url,
            },
            true, // showNotifications = true
        );

        try {
            await focusJJLog(page);

            // Wait for the warning notification toast to appear
            await expectNotificationToast(page, "requires 'Merge Request' read/write permissions or 'api' scope");
        } finally {
            gitlab.statusOverride = undefined;
            maybePrintExtensionLogs(userDataDir);
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
