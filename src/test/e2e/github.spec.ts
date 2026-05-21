/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { FakeGitHubServer } from '../helpers/fake-github-server';
import { buildGraph, type CommitDefinition, TestRepo } from '../test-repo';
import { expectBadgeLink, focusJJLog, launchVSCode, waitForLogCommitRow } from './e2e-helpers';

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
});
