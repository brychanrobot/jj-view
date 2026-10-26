/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeGerritServer } from '../helpers/fake-gerrit-server';
import { ARTIFACT_DIR, expect, recordGifFlow, StandaloneServer, test, waitForScmReady } from './standalone-fixture';

/**
 * Review comments in the standalone web UI: the Comments tab opened from a
 * commit's comment badge, and threads rendered inline in the diff viewer.
 * Runs end to end against a loopback fake Gerrit so replies/resolutions hit a
 * real (fake) forge through the daemon.
 */
test.describe('Standalone Web Review Comments', () => {
    let gerrit: FakeGerritServer;

    test.beforeAll(async () => {
        gerrit = new FakeGerritServer();
        await gerrit.start();
    });

    test.afterAll(async () => {
        await gerrit.stop();
    });

    test.beforeEach(() => {
        gerrit.reset();
    });

    test('opens the Comments tab, shows threads inline in the diff, and replies', async ({ page, testRepo }) => {
        testRepo.writeFile('file.txt', 'line one\nline two\nline three\n');
        const changeId = `I${'3'.repeat(40)}`;
        testRepo.describe(`Reviewed change\n\nChange-Id: ${changeId}`);
        const clNumber = gerrit.registerChange(changeId);
        gerrit.updateChange(changeId, { unresolved_comment_count: 1 });
        gerrit.registerComments(clNumber, {
            'file.txt': [
                {
                    id: 'thread-open',
                    line: 2,
                    message: 'Please rename this variable',
                    updated: '2023-01-02T10:00:00.000Z',
                    unresolved: true,
                    patch_set: 1,
                    author: { name: 'Reviewer', username: 'reviewer' },
                },
                {
                    id: 'thread-done',
                    line: 3,
                    message: 'Nit: trailing whitespace',
                    updated: '2023-01-02T09:00:00.000Z',
                    unresolved: false,
                    patch_set: 1,
                    author: { name: 'Reviewer', username: 'reviewer' },
                },
            ],
        });

        const server = new StandaloneServer(testRepo, {
            prepareUserData: (userDataDir) => {
                fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ 'gerrit.host': gerrit.url }));
            },
        });
        await server.start();
        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            const gifPath = path.join(ARTIFACT_DIR, 'comments-flow.gif');
            await recordGifFlow(
                page,
                async (captureFrame) => {
                    // 1. The commit row advertises its unresolved comments.
                    const row = page
                        .locator('[data-testid="log-content"] .commit-row')
                        .filter({ hasText: 'Reviewed change' });
                    const commentsButton = row.locator('.comments-button');
                    await expect(commentsButton).toBeVisible({ timeout: 20000 });
                    await captureFrame();

                    // 2. Clicking it opens the Comments tab with the unresolved thread.
                    await commentsButton.click();
                    const pane = page.locator('[data-testid="comments-pane"]');
                    await expect(pane).toBeVisible({ timeout: 20000 });
                    await expect(pane.locator('[data-testid="comments-pane-title"]')).toContainText(String(clNumber));
                    await expect(pane.locator('[data-testid="comments-unresolved-count"]')).toHaveText('1');
                    const openThread = pane.locator('[data-testid="comment-thread"][data-thread-id="thread-open"]');
                    await expect(openThread).toBeVisible();
                    await expect(openThread).toContainText('Please rename this variable');
                    await expect(openThread.locator('[data-testid="comment-thread-location"]')).toHaveText('Line 2');
                    // Resolved threads are hidden until requested.
                    const doneThread = pane.locator('[data-testid="comment-thread"][data-thread-id="thread-done"]');
                    await expect(doneThread).toHaveCount(0);
                    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'comments-pane.png') });
                    await captureFrame();

                    await pane.locator('[data-testid="comments-show-resolved"]').check();
                    await expect(doneThread).toBeVisible();
                    await expect(doneThread).toHaveAttribute('data-resolved', 'true');
                    await captureFrame();

                    // 3. The file heading opens the diff, which renders the threads inline.
                    await pane.locator('[data-testid="comments-file-link"]', { hasText: 'file.txt' }).click();
                    await expect(page.locator('[data-testid="pierre-diff-viewer"]')).toBeVisible({ timeout: 20000 });
                    const inlineOpen = page.locator(
                        '[data-testid="diff-comment-annotation"][data-thread-id="thread-open"]',
                    );
                    await expect(inlineOpen).toBeVisible({ timeout: 20000 });
                    await expect(inlineOpen).toContainText('Please rename this variable');
                    // Both threads are anchored to their lines; the resolved one starts collapsed.
                    const inlineDone = page.locator(
                        '[data-testid="diff-comment-annotation"][data-thread-id="thread-done"]',
                    );
                    await expect(inlineDone).toBeVisible();
                    await expect(inlineDone.locator('[data-testid="comment"]')).toHaveCount(0);
                    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'comments-inline-diff.png') });
                    await captureFrame();

                    // 4. Replying from the inline thread posts a Gerrit draft and shows it.
                    await inlineOpen
                        .locator('[data-testid="comment-reply-input"]')
                        .fill('Renamed in the next patch set');
                    await inlineOpen.locator('[data-testid="comment-reply"]').click();
                    await expect
                        .poll(
                            () =>
                                gerrit.requestLog.some((r) =>
                                    r.url.includes(`/changes/${clNumber}/revisions/1/drafts`),
                                ),
                            { timeout: 20000 },
                        )
                        .toBe(true);
                    const draftComment = inlineOpen.locator('[data-testid="comment"]').filter({ hasText: 'Draft' });
                    await expect(draftComment).toBeVisible({ timeout: 20000 });
                    await expect(draftComment).toContainText('Renamed in the next patch set');
                    // The input clears once the reply command resolves.
                    await expect(inlineOpen.locator('[data-testid="comment-reply-input"]')).toHaveValue('', {
                        timeout: 20000,
                    });
                    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'comments-inline-reply.png') });
                    await captureFrame();

                    // 5. Resolving posts a resolving draft; the thread flips to resolved.
                    await inlineOpen.locator('[data-testid="comment-toggle-resolved"]').click();
                    await expect(inlineOpen.locator('[data-testid="comment-thread"]')).toHaveAttribute(
                        'data-resolved',
                        'true',
                        { timeout: 20000 },
                    );
                    await captureFrame();
                },
                { outputPath: gifPath },
            );
        } finally {
            await server.stop();
        }
    });

    test('shows inline threads for the working copy diff without opening the Comments tab', async ({
        page,
        testRepo,
    }) => {
        testRepo.writeFile('notes.md', '# Notes\n\nSome text\n');
        const changeId = `I${'4'.repeat(40)}`;
        testRepo.describe(`Docs change\n\nChange-Id: ${changeId}`);
        const clNumber = gerrit.registerChange(changeId);
        gerrit.updateChange(changeId, { unresolved_comment_count: 1 });
        gerrit.registerComments(clNumber, {
            'notes.md': [
                {
                    id: 'notes-thread',
                    line: 1,
                    message: 'Use a more specific title',
                    updated: '2023-01-02T10:00:00.000Z',
                    unresolved: true,
                    author: { name: 'Reviewer', username: 'reviewer' },
                },
            ],
        });

        const server = new StandaloneServer(testRepo, {
            prepareUserData: (userDataDir) => {
                fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ 'gerrit.host': gerrit.url }));
            },
        });
        await server.start();
        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            // Wait for the forge data to land before opening the diff.
            const row = page.locator('[data-testid="log-content"] .commit-row').filter({ hasText: 'Docs change' });
            await expect(row.locator('.comments-button')).toBeVisible({ timeout: 20000 });

            await page
                .locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]')
                .filter({ hasText: 'notes.md' })
                .first()
                .click();
            await expect(page.locator('[data-testid="pierre-diff-viewer"]')).toBeVisible({ timeout: 20000 });
            const inline = page.locator('[data-testid="diff-comment-annotation"][data-thread-id="notes-thread"]');
            await expect(inline).toBeVisible({ timeout: 20000 });
            await expect(inline).toContainText('Use a more specific title');
            await expect(page.locator('[data-testid="comments-pane"]')).toHaveCount(0);

            // The multi-file diff (CodeView) anchors the same thread.
            await page.evaluate(() => {
                void window.__JJ_VIEW_ENV__?.commands.executeCommand('jj-view.showMultiFileDiff');
            });
            const multiDiff = page.locator('[data-testid="pierre-multi-diff-viewer"]');
            await expect(multiDiff).toBeVisible({ timeout: 20000 });
            const multiInline = multiDiff.locator(
                '[data-testid="diff-comment-annotation"][data-thread-id="notes-thread"]',
            );
            await expect(multiInline).toBeVisible({ timeout: 20000 });
            await expect(multiInline).toContainText('Use a more specific title');
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'comments-multi-diff.png') });
        } finally {
            await server.stop();
        }
    });
});
