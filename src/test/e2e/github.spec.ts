/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { FakeGitHubServer } from '../helpers/fake-github-server';
import { buildGraph, type CommitDefinition, TestRepo } from '../test-repo';
import {
    expectBadgeLink,
    expectNotificationToast,
    focusJJLog,
    focusSCM,
    launchVSCode,
    locateQuickInputItem,
    locateQuickInputWidget,
    pickQuickPickItem,
    waitForLogCommitRow,
    waitForQuickInput,
} from './e2e-helpers';

test.describe('GitHub Integration E2E', () => {
    let github: FakeGitHubServer;

    test.beforeAll(async () => {
        github = new FakeGitHubServer();
        await github.start();
    });

    test.afterAll(async () => {
        await github.stop();
    });

    test.beforeEach(() => {
        github.clearRequests();
    });

    test('Detects GitHub PR status via bookmark', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://github.com/test-owner/test-repo.git');

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'pr-commit', parents: ['base'], description: 'PR Commit', bookmarks: ['my-feature-branch'] },
        ];

        const commits = await buildGraph(repo, graph);

        github.registerPR('my-feature-branch', {
            id: 'pr_node_id_123',
            number: 42,
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            url: 'https://github.com/test-owner/test-repo/pull/42',
            currentRevision: commits['pr-commit'].commitId,
            unresolvedComments: 3,
        });

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'github',
            },
            {
                JJ_VIEW_GITHUB_API_URL: github.url,
                JJ_VIEW_GITHUB_TOKEN: 'test-token',
            },
        );

        try {
            await focusJJLog(page);

            const row = await waitForLogCommitRow(page, 'PR Commit');

            // Verify PR label is shown with correct number and URL
            await expectBadgeLink(row, 'PR #42', 'https://github.com/test-owner/test-repo/pull/42');

            // Verify unresolved comments bubble is shown
            await expect(row.getByTitle('3 Unresolved Comments')).toBeVisible();

            // Since commit ID matches currentRevision, upload button should NOT be visible
            const uploadButton = row.getByRole('button', { name: 'Upload changes to GitHub' });
            await expect(uploadButton).not.toBeVisible();
        } finally {
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
        repo.addRemote('origin', 'https://github.com/test-owner/test-repo.git');

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
        github.registerPR('my-feature-branch-2', {
            id: 'pr_node_id_456',
            number: 101,
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            url: 'https://github.com/test-owner/test-repo/pull/101',
            currentRevision: 'different-commit-sha',
        });

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'github',
                'jj-view.uploadCommand': 'describe -m uploaded_successfully',
            },
            {
                JJ_VIEW_GITHUB_API_URL: github.url,
                JJ_VIEW_GITHUB_TOKEN: 'test-token',
            },
        );

        try {
            await focusJJLog(page);

            const row = await waitForLogCommitRow(page, 'Out of Sync Commit');

            // Verify PR label and URL
            await expectBadgeLink(row, 'PR #101', 'https://github.com/test-owner/test-repo/pull/101');

            // Verify upload button is visible
            const uploadButton = row.getByRole('button', { name: 'Upload changes to GitHub' });
            await expect(uploadButton).toBeVisible();

            // Click upload button
            await uploadButton.click();

            const changeId = commits['out-of-sync-commit'].changeId;
            await expect(async () => {
                const desc = repo.getDescription(changeId);
                expect(desc).toContain('uploaded_successfully');
            }).toPass({ timeout: 15000 });
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('PR badge is only shown on local bookmark commits, and parent/structure sync indicators are correct', async () => {
        const remoteRepo = new TestRepo();
        remoteRepo.init();

        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', remoteRepo.path);
        repo.addRemote('origin-github', 'https://github.com/test-owner/test-repo.git');
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');

        // Create the parent commit
        const graph: CommitDefinition[] = [
            { label: 'base', parents: ['root()'], description: 'base' },
            { label: 'parent', parents: ['base'], description: 'Parent Commit', bookmarks: ['my-pr-branch'] },
        ];
        const commits = await buildGraph(repo, graph);

        // Push it to create the remote bookmark on parent
        repo.gitPush('my-pr-branch');
        remoteRepo.gitImport();

        // Create the child commit on top of parent, and move the local bookmark there
        const parentChangeId = commits.parent.changeId;
        repo.new([parentChangeId], 'Child Commit');
        const childChangeId = repo.getChangeId('@');
        repo.bookmarkMove('my-pr-branch', childChangeId);

        // Register the PR on the fake GitHub server for the branch
        const parentCommitId = commits.parent.commitId;
        github.registerPR('my-pr-branch', {
            id: 'pr_node_id_789',
            number: 42,
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            url: 'https://github.com/test-owner/test-repo/pull/42',
            currentRevision: parentCommitId,
        });

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'github',
            },
            {
                JJ_VIEW_GITHUB_API_URL: github.url,
                JJ_VIEW_GITHUB_TOKEN: 'test-token',
            },
        );

        try {
            await focusJJLog(page);

            const childRow = await waitForLogCommitRow(page, 'Child Commit');
            const parentRow = await waitForLogCommitRow(page, 'Parent Commit');

            // 1. Child row should show the PR #42 badge and URL (since it has local bookmark)
            await expectBadgeLink(childRow, 'PR #42', 'https://github.com/test-owner/test-repo/pull/42');

            // 2. Parent row should NOT show the PR #42 badge (since it only has remote bookmark)
            await expect(parentRow.locator('a', { hasText: 'PR #42' })).not.toBeVisible();

            // 3. Child row has local changes that need upload, and parent has correct structure (no parent mismatch).
            // So the child row upload button should NOT show the parent mismatch title.
            const uploadButton = childRow.getByRole('button', { name: 'Upload changes to GitHub' });
            await expect(uploadButton).toBeVisible();
            await expect(uploadButton).toHaveAttribute('title', 'Local changes need upload (Click to push)');
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
            remoteRepo.dispose();
        }
    });

    test('Manages GitHub auth choices via Quick Pick', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://github.com/test-owner/test-repo.git');

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'github',
            },
            {
                JJ_VIEW_GITHUB_API_URL: github.url,
            },
        );

        try {
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
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Manages GitHub PAT flow via Quick Pick', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://github.com/test-owner/test-repo.git');

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'github',
            },
            {
                JJ_VIEW_GITHUB_API_URL: github.url,
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
            await input.fill('ghp_test-mock-token');
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
            await expectNotificationToast(page, 'Successfully cleared stored GitHub Personal Access Token');

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
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });

    test('Detects PR from fork targeting mainline repo', async () => {
        const repo = new TestRepo();
        repo.init();
        repo.addRemote('origin', 'https://github.com/mainline-owner/mainline-repo.git');
        repo.addRemote('fork', 'https://github.com/fork-owner/fork-repo.git');

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'fork-commit', parents: ['base'], description: 'Fork Commit', bookmarks: ['my-fork-branch'] },
        ];

        const commits = await buildGraph(repo, graph);

        github.registerPR('my-fork-branch', {
            id: 'pr_node_id_fork',
            number: 99,
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            url: 'https://github.com/mainline-owner/mainline-repo/pull/99',
            currentRevision: commits['fork-commit'].commitId,
            headOwner: 'fork-owner',
        });

        const { app, page, userDataDir } = await launchVSCode(
            repo,
            {
                'jj-view.codeForge.provider': 'github',
            },
            {
                JJ_VIEW_GITHUB_API_URL: github.url,
                JJ_VIEW_GITHUB_TOKEN: 'test-token',
            },
        );

        try {
            await focusJJLog(page);

            const row = await waitForLogCommitRow(page, 'Fork Commit');

            // Verify PR badge is shown with correct number and URL (even though the headOwner is 'fork-owner')
            await expectBadgeLink(row, 'PR #99', 'https://github.com/mainline-owner/mainline-repo/pull/99');
        } finally {
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
