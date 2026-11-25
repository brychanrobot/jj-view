/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

function runCliBinary(
    binaryPath: string,
    args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined || k.startsWith('ANTIGRAVITY_') || k.startsWith('JJ_VIEW_')) {
            continue;
        }
        cleanEnv[k] = v;
    }
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(binaryPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: cleanEnv,
        });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf-8');
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8');
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attachPageErrorCollector(targetPage: Page, bucket: string[]): void {
    targetPage.on('pageerror', (err) => {
        const isExpectedAgentApiUnavailable =
            err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
        if (!isExpectedAgentApiUnavailable) {
            bucket.push(err.message);
        }
    });
}

function extractPrintedTabUrl(stdout: string): string {
    const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+/);
    expect(match, `expected printed tab URL in stdout:\n${stdout}`).not.toBeNull();
    return match?.[0] ?? '';
}

test.describe('Standalone Web SVG Favicon, Window Title, and CLI New-Tab Open', () => {
    test('serves SVG favicon, updates window title reactively, and opens folders in dedicated tabs via CLI', async ({
        context,
        page,
        server,
        testRepo,
    }) => {
        const pageErrors: string[] = [];
        attachPageErrorCollector(page, pageErrors);

        testRepo.writeFile('alpha.txt', 'alpha initial\n');
        testRepo.describe('alpha commit');
        testRepo.new();
        testRepo.writeFile('alpha_dirty.txt', 'alpha working copy\n');

        const repo2 = new TestRepo();
        const repo3 = new TestRepo();
        const extraPages: Page[] = [];
        try {
            repo2.init();
            repo2.writeFile('beta.txt', 'beta initial\n');
            repo2.describe('beta commit');
            repo2.new();
            repo2.writeFile('beta_dirty.txt', 'beta working copy\n');

            repo3.init();
            repo3.writeFile('gamma.txt', 'gamma initial\n');
            repo3.describe('gamma commit');
            repo3.new();
            repo3.writeFile('gamma_dirty.txt', 'gamma working copy\n');

            const repo1Name = path.basename(testRepo.path);
            const repo2Name = path.basename(repo2.path);
            const repo3Name = path.basename(repo3.path);

            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            // 1. Verify SVG favicon link and /favicon.ico + /dist/favicon.svg endpoints
            const faviconLink = page.locator('head link[rel="icon"]');
            await expect(faviconLink).toHaveAttribute('type', 'image/svg+xml');
            const faviconHref = await faviconLink.getAttribute('href');
            expect(faviconHref).toMatch(/^\/dist\/favicon\.svg\?v=/);

            const faviconIcoResp = await page.request.get(`${server.baseUrl}/favicon.ico`);
            expect(faviconIcoResp.status()).toBe(200);
            expect(faviconIcoResp.headers()['content-type']).toContain('image/svg+xml');
            const faviconSvgText = await faviconIcoResp.text();
            expect(faviconSvgText).toContain('<svg');
            expect(faviconSvgText).toContain('viewBox=');

            const distFaviconResp = await page.request.get(
                `${server.baseUrl}/dist/favicon.svg?token=${server.sessionToken}`,
            );
            expect(distFaviconResp.status()).toBe(200);
            expect(distFaviconResp.headers()['content-type']).toContain('image/svg+xml');

            // 2. Verify initial window title and reactive tab title
            await expect(page).toHaveTitle(`${repo1Name} \u2014 JJ View`);

            let tab2Url = '';
            await recordGifFlow(
                page,
                async (capture) => {
                    await capture();

                    const alphaItem = page.getByTestId('scm-resource-item').filter({ hasText: 'alpha_dirty.txt' });
                    await expect(alphaItem).toBeVisible({ timeout: 10000 });
                    await alphaItem.click();

                    await expect(page.getByTestId('tab-bar-container')).toBeVisible({ timeout: 10000 });
                    await expect(page).toHaveTitle(
                        new RegExp(`^alpha_dirty\\.txt \\([^)]+\\) \u2014 ${escapeRegExp(repo1Name)} \u2014 JJ View$`),
                    );
                    await capture();

                    // Close the diff tab and confirm window title reverts
                    await page.locator('[data-testid^="tab-close-btn-"]').first().click();
                    await expect(page).toHaveTitle(`${repo1Name} \u2014 JJ View`);
                    await capture();

                    // 3. Run `jj-view --port <port> --repo <repo2> --user-data-dir <dir> --no-open`
                    const attachRes = await runCliBinary(server.binaryPath, [
                        '--host',
                        '127.0.0.1',
                        '--port',
                        String(server.port),
                        '--repo',
                        repo2.path,
                        '--user-data-dir',
                        server.userDataDir,
                        '--no-open',
                    ]);
                    expect(attachRes.code, `stderr: ${attachRes.stderr}`).toBe(0);
                    tab2Url = extractPrintedTabUrl(attachRes.stdout);
                    const parsedTab2Url = new URL(tab2Url);
                    expect(parsedTab2Url.searchParams.get('repo')).toBe(repo2.path);
                    expect(parsedTab2Url.searchParams.get('token')).toBe(server.sessionToken);

                    // Tab 1 must stay untouched on repo1 (single-repo view renders 0 multi-repo sections)
                    await expect(page.getByTestId('scm-repository-section')).toHaveCount(0);
                    await expect(page).toHaveTitle(`${repo1Name} \u2014 JJ View`);
                    await expect(page.getByTestId('scm-pane')).toContainText('alpha_dirty.txt');
                    await expect(page.getByTestId('scm-pane')).not.toContainText('beta_dirty.txt');
                    await capture();
                },
                { outputPath: path.join(ARTIFACT_DIR, 'web-ux-cli-open-flow.gif') },
            );

            // 4. Open printed URL for repo2 in a dedicated new browser tab
            const page2 = await context.newPage();
            extraPages.push(page2);
            attachPageErrorCollector(page2, pageErrors);
            await page2.goto(tab2Url);
            await waitForScmReady(page2);

            await expect(page2).toHaveTitle(`${repo2Name} \u2014 JJ View`);
            const page2Url = new URL(page2.url());
            expect(page2Url.searchParams.has('token')).toBe(false);
            expect(page2Url.searchParams.get('repo')).toBe(repo2.path);
            await expect(page2.getByTestId('scm-repository-section')).toHaveCount(0);
            await expect(page2.getByTestId('scm-pane')).toContainText('beta_dirty.txt');
            await expect(page2.getByTestId('scm-pane')).not.toContainText('alpha_dirty.txt');
            await expect(page2.getByTestId('log-pane')).toContainText('beta commit');

            // Reload page2 and confirm it stays scoped to repo2
            await page2.reload();
            await waitForScmReady(page2);
            await expect(page2.getByTestId('scm-repository-section')).toHaveCount(0);
            await expect(page2.getByTestId('scm-pane')).toContainText('beta_dirty.txt');
            await expect(page2.getByTestId('scm-pane')).not.toContainText('alpha_dirty.txt');

            // 5. Run explicit `jj-view open` subcommand for repo3 and open its URL in tab 3
            const openRes = await runCliBinary(server.binaryPath, [
                'open',
                '--host',
                '127.0.0.1',
                '--port',
                String(server.port),
                '--user-data-dir',
                server.userDataDir,
                '--no-open',
                repo3.path,
            ]);
            expect(openRes.code, `stderr: ${openRes.stderr}`).toBe(0);
            const tab3Url = extractPrintedTabUrl(openRes.stdout);
            expect(new URL(tab3Url).searchParams.get('repo')).toBe(repo3.path);

            const page3 = await context.newPage();
            extraPages.push(page3);
            attachPageErrorCollector(page3, pageErrors);
            await page3.goto(tab3Url);
            await waitForScmReady(page3);

            await expect(page3).toHaveTitle(`${repo3Name} \u2014 JJ View`);
            await expect(page3.getByTestId('scm-repository-section')).toHaveCount(0);
            await expect(page3.getByTestId('scm-pane')).toContainText('gamma_dirty.txt');
            await expect(page3.getByTestId('scm-pane')).not.toContainText('alpha_dirty.txt');
            await expect(page3.getByTestId('scm-pane')).not.toContainText('beta_dirty.txt');
            await expect(page3.getByTestId('log-pane')).toContainText('gamma commit');

            // Confirm Tab 1 still remains completely scoped to repo1
            await expect(page.getByTestId('scm-repository-section')).toHaveCount(0);
            await expect(page.getByTestId('scm-pane')).toContainText('alpha_dirty.txt');
            await expect(page.getByTestId('scm-pane')).not.toContainText('gamma_dirty.txt');

            await page3.screenshot({
                path: path.join(ARTIFACT_DIR, 'web-ux-and-cli-open.png'),
                fullPage: true,
            });
            expect(fs.existsSync(path.join(ARTIFACT_DIR, 'web-ux-and-cli-open.png'))).toBe(true);
            expect(pageErrors).toEqual([]);
        } finally {
            await Promise.all(extraPages.map((p) => p.close().catch(() => {})));
            await repo2.dispose();
            await repo3.dispose();
        }
    });
});
