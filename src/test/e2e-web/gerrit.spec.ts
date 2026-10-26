/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FakeGerritServer } from '../helpers/fake-gerrit-server';
import { expect, StandaloneServer, test, waitForScmReady } from './standalone-fixture';

/**
 * Gerrit in the standalone web UI. Unlike GitHub/GitLab, Gerrit's REST API
 * does not allow cross-origin browser requests and its credentials live in git
 * (gitcookies, git-remote-sso). Both are handled by routing requests through
 * the daemon (`HostHttp`), which these tests exercise end to end against a
 * loopback fake Gerrit.
 */
test.describe('Standalone Web Gerrit Integration', () => {
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

    test('shows CL status fetched by the daemon with git credentials', async ({ page, testRepo }) => {
        testRepo.writeFile('file.txt', 'content');
        const changeId = `I${'1'.repeat(40)}`;
        testRepo.describe(`Gerrit change\n\nChange-Id: ${changeId}`);
        const clNumber = gerrit.registerChange(changeId);

        const gerritHost = new URL(gerrit.url).hostname;
        const server = new StandaloneServer(testRepo, {
            prepareUserData: (userDataDir) => {
                fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ 'gerrit.host': gerrit.url }));
                // The daemon resolves git credentials the way git does; a
                // gitcookies entry for the fake host must reach Gerrit as
                // Basic auth without ever being sent to the page.
                fs.writeFileSync(
                    path.join(userDataDir, '.gitcookies'),
                    `${gerritHost}\tTRUE\t/\tTRUE\t2147483647\to\tgit-e2e.example.com=cookie-secret\n`,
                );
            },
        });
        await server.start();
        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            const row = page.locator('[data-testid="log-content"] .commit-row').filter({ hasText: 'Gerrit change' });
            const badge = row.locator('a.cl-link', { hasText: `CL/${clNumber}` });
            await expect(badge).toBeVisible({ timeout: 20000 });
            await expect(badge).toHaveAttribute('href', `${gerrit.url}/c/${clNumber}`);

            // Authenticated endpoint (/a/) was used, with the cookie-derived credential.
            const expectedAuth = `Basic ${Buffer.from('git-e2e.example.com:cookie-secret').toString('base64')}`;
            await expect
                .poll(() => gerrit.requestLog.find((r) => r.url.startsWith('/a/changes/'))?.headers.authorization, {
                    timeout: 20000,
                })
                .toBe(expectedAuth);

            // The credential never reaches the browser.
            const pageHtml = await page.content();
            expect(pageHtml).not.toContain('cookie-secret');
            expect(pageHtml).not.toContain(expectedAuth);
        } finally {
            await server.stop();
        }
    });

    test('falls back to unauthenticated requests when no git credential exists', async ({ page, testRepo }) => {
        testRepo.writeFile('file.txt', 'content');
        const changeId = `I${'2'.repeat(40)}`;
        testRepo.describe(`Public change\n\nChange-Id: ${changeId}`);
        const clNumber = gerrit.registerChange(changeId);

        const server = new StandaloneServer(testRepo, {
            prepareUserData: (userDataDir) => {
                fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ 'gerrit.host': gerrit.url }));
            },
        });
        await server.start();
        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            const row = page.locator('[data-testid="log-content"] .commit-row').filter({ hasText: 'Public change' });
            await expect(row.locator('a.cl-link', { hasText: `CL/${clNumber}` })).toBeVisible({ timeout: 20000 });

            const changeRequests = gerrit.requestLog.filter((r) => r.url.includes('/changes/'));
            expect(changeRequests.length).toBeGreaterThan(0);
            expect(changeRequests.every((r) => !r.url.startsWith('/a/') && !r.headers.authorization)).toBe(true);
        } finally {
            await server.stop();
        }
    });
});
