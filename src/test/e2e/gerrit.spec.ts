/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { convertJjChangeIdToHex } from '../../utils/jj-utils';
import { FakeGerritServer } from '../helpers/fake-gerrit-server';
import { buildGraph, type CommitDefinition, TestRepo } from '../test-repo';
import {
    expectBadgeLink,
    focusJJLog,
    getReviewWidget,
    maybePrintExtensionLogs,
    openFileInEditor,
    replyToCommentThread,
    resolveCommentThread,
    test,
    unresolveCommentThread,
    waitForCommentThreadsCount,
    waitForLogCommitRow,
    waitForThreadState,
} from './e2e-helpers';

test.describe('Gerrit Integration E2E', () => {
    let gerrit: FakeGerritServer;

    test.beforeAll(async () => {
        gerrit = new FakeGerritServer();
        await gerrit.start();
    });

    test.afterAll(async () => {
        await gerrit.stop();
    });

    test('Detects Gerrit status via various methods (Change-Id, Link, Mixed, and Fallback)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'explicit-change-id', parents: ['base'], description: 'Explicit Change-Id' },
            { label: 'fallback-only', parents: ['base'], description: 'Fallback Only' },
            { label: 'link-only', parents: ['base'], description: 'Link Only' },
            { label: 'mixed-trailers', parents: ['fallback-only'], description: 'Mixed trailers' },
        ];

        const commits = await buildGraph(repo, graph);
        const clNumbers: Record<string, number> = {};

        // 1. Explicit Change-Id (Must be 40 hex digits)
        const id1 = `I${'1'.repeat(40)}`;
        repo.describe(`Explicit Change-Id\n\nChange-Id: ${id1}`, commits['explicit-change-id'].changeId);
        clNumbers['explicit-change-id'] = gerrit.registerChange(id1);

        // 2. Fallback Only (No trailer)
        const idFallback = `I${convertJjChangeIdToHex(commits['fallback-only'].changeId)}`;
        clNumbers['fallback-only'] = gerrit.registerChange(idFallback, 'mismatched-parent');

        // 3. Link Only
        const numLink = 1234;
        repo.describe(`Link Only\n\nLink: ${gerrit.url}/c/project/+/${numLink}`, commits['link-only'].changeId);
        gerrit.registerChangeByNumber(numLink);
        clNumbers['link-only'] = numLink;

        // 4. Mixed (Both trailers)
        const idMixed = `I${'2'.repeat(40)}`;
        const numMixed = 5678;
        repo.describe(
            `Mixed trailers\n\nChange-Id: ${idMixed}\nLink: http://localhost/${numMixed}`,
            commits['mixed-trailers'].changeId,
        );
        gerrit.registerChangeByNumber(numMixed, idMixed);
        clNumbers['mixed-trailers'] = numMixed;

        const { page } = await vscode.openWorkspace(repo, {
            'jj-view.gerrit.host': gerrit.url,
            'jj-view.uploadCommand': 'describe -m uploaded_successfully',
        });

        await focusJJLog(page);

        // Verify rows show Gerrit status

        // Explicit Change-Id
        const row1 = await waitForLogCommitRow(page, 'Explicit Change-Id');
        await expectBadgeLink(
            row1,
            `CL/${clNumbers['explicit-change-id']}`,
            `${gerrit.url}/c/${clNumbers['explicit-change-id']}`,
        );

        // Fallback (has parent mismatch)
        const rowFallback = await waitForLogCommitRow(page, 'Fallback Only');
        await expectBadgeLink(
            rowFallback,
            `CL/${clNumbers['fallback-only']}`,
            `${gerrit.url}/c/${clNumbers['fallback-only']}`,
        );

        const uploadButton = rowFallback.getByRole('button', { name: 'Upload changes to Gerrit' });
        await expect(uploadButton).toBeVisible();

        // Link Only
        const rowLink = await waitForLogCommitRow(page, 'Link Only');
        await expectBadgeLink(rowLink, `CL/${clNumbers['link-only']}`, `${gerrit.url}/c/${clNumbers['link-only']}`);

        // Mixed
        const rowMixed = await waitForLogCommitRow(page, 'Mixed trailers');
        await expectBadgeLink(
            rowMixed,
            `CL/${clNumbers['mixed-trailers']}`,
            `${gerrit.url}/c/${clNumbers['mixed-trailers']}`,
        );

        // Test upload command
        await uploadButton.click();
        const fallbackId = commits['fallback-only'].changeId;
        await expect(async () => {
            const desc = repo.getDescription(fallbackId);
            expect(desc).toContain('uploaded_successfully');
        }).toPass({ timeout: 15000 });
    });

    test("Detects 'Needs Upload' after rebase (rebase hole)", async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            { label: 'parent', parents: ['base'], description: 'Parent' },
            { label: 'child', parents: ['parent'], description: 'Child' },
        ];

        const commits = await buildGraph(repo, graph);

        // Register both in Gerrit
        const parentId = `I${convertJjChangeIdToHex(commits.parent.changeId)}`;
        const childId = `I${convertJjChangeIdToHex(commits.child.changeId)}`;

        // Gerrit state matches initial local state
        gerrit.registerChange(parentId, 'base-sha');
        gerrit.registerChange(childId, 'sha-1000'); // sha-1000 is what parent gets in mock Gerrit

        // Rebase child to base locally (skipping parent)
        repo.rebase({ source: commits.child.changeId, destination: commits.base.changeId });

        const { page } = await vscode.openWorkspace(repo, {
            'jj-view.gerrit.host': gerrit.url,
        });

        await focusJJLog(page);

        // Row for Child should show upload button because parent mismatch
        // (locally points to base, Gerrit expects 'sha-1000' which is the old parent)
        const rowChild = await waitForLogCommitRow(page, 'Child');
        const uploadButton = rowChild.getByRole('button', { name: 'Upload changes to Gerrit' });
        await expect(uploadButton).toBeVisible({ timeout: 20000 });
    });

    test('Clicks unresolved comments bubble and fetches Gerrit comments', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();

        const graph: CommitDefinition[] = [
            { label: 'base', description: 'base' },
            {
                label: 'commit-with-comments',
                parents: ['base'],
                description: 'Commit with comments',
                files: {
                    'file.txt': 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n',
                },
            },
        ];

        const commits = await buildGraph(repo, graph);

        const changeId = `I${'3'.repeat(40)}`;
        repo.describe(`Commit with comments\n\nChange-Id: ${changeId}`, commits['commit-with-comments'].changeId);
        const changeNumber = gerrit.registerChange(changeId);
        const change = gerrit.changes.get(changeId);
        if (change) {
            change.unresolved_comment_count = 3;
        }

        gerrit.registerComments(changeNumber, {
            'file.txt': [
                {
                    id: 'comment-1',
                    line: 10,
                    message: 'Gerrit unresolved comment',
                    updated: '2026-06-30 12:00:00.000000000',
                    author: { name: 'reviewer', username: 'reviewer' },
                    unresolved: true,
                },
            ],
        });

        const { page } = await vscode.openWorkspace(repo, {
            'jj-view.gerrit.host': gerrit.url,
        });

        try {
            await focusJJLog(page);

            const row = await waitForLogCommitRow(page, 'Commit with comments');
            const bubble = row.getByTitle('3 Unresolved Comments');
            await expect(bubble).toBeVisible();

            await bubble.click();

            // Wait until the fake server receives a request for /comments
            await expect
                .poll(() => {
                    return gerrit.requests.some((req) => req.includes('/comments'));
                })
                .toBe(true);

            // Wait for CommentsManager to parse and populate the threads
            await waitForCommentThreadsCount(vscode);

            // Open the file in the editor to show the review widget
            await openFileInEditor(vscode, page, 'file.txt', repo);

            // Wait for the review widget to appear in the editor DOM
            const reviewWidget = await getReviewWidget(page, 'Gerrit unresolved comment');

            // Type and submit the reply
            await replyToCommentThread(page, reviewWidget, 'My Gerrit E2E reply');

            // Assert that the fake server receives the review post request (reply)
            await expect
                .poll(() => {
                    return gerrit.requests.some((req) => req.includes('/review'));
                })
                .toBe(true);

            gerrit.clearRequests();

            // Wait for the reply to be rendered in the UI
            await expect(reviewWidget).toContainText('My Gerrit E2E reply');

            // Resolve the thread
            await resolveCommentThread(reviewWidget);

            // Assert that the fake server receives the review post request (resolve)
            await expect
                .poll(() => {
                    return gerrit.requests.some((req) => req.includes('/review'));
                })
                .toBe(true);

            gerrit.clearRequests();

            // Wait for CommentsManager to update the thread to resolved & collapsed
            await waitForThreadState(vscode, 'resolved', 0);

            // Wait for the review widget to be hidden
            await expect(page.locator('.review-widget')).toBeHidden();

            // Expand the thread since resolving it collapsed it
            await page.locator('.comment-range-glyph').first().click();

            // Wait for the review widget to appear in the editor DOM again
            const reviewWidget2 = await getReviewWidget(page, 'Gerrit unresolved comment');

            // Unresolve the thread
            await unresolveCommentThread(reviewWidget2);

            // Assert that the fake server receives the review post request (unresolve)
            await expect
                .poll(() => {
                    return gerrit.requests.some((req) => req.includes('/review'));
                })
                .toBe(true);
        } finally {
            maybePrintExtensionLogs(vscode.userDataDir);
        }
    });
});
