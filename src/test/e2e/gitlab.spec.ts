/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { FakeGitLabServer } from '../helpers/fake-gitlab-server';
import { buildGraph, type CommitDefinition, TestRepo } from '../test-repo';
import { expectBadgeLink, focusJJLog, launchVSCode, waitForLogCommitRow } from './e2e-helpers';

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
            await app.close();
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {}
            repo.dispose();
        }
    });
});
