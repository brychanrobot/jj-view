/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { TestRepo } from '../test-repo';
import {
    ARTIFACT_DIR,
    test as baseFixtureTest,
    expect,
    recordInteractionFlow,
    StandaloneServer,
    waitForScmReady,
} from './standalone-fixture';

declare global {
    interface Window {
        __OPENED_EXTERNAL_URLS__?: string[];
    }
}

const nonColocatedTest = baseFixtureTest.extend<{
    testRepo: TestRepo;
    server: StandaloneServer;
}>({
    testRepo: async ({ playwright: _unused }, use) => {
        const repo = new TestRepo();
        try {
            repo.init({ colocate: false });
            await use(repo);
        } finally {
            await repo.dispose();
        }
    },
    server: async ({ testRepo }, use) => {
        const server = new StandaloneServer(testRepo);
        try {
            await server.start();
            await use(server);
        } finally {
            await server.stop();
        }
    },
});

function setRemoteUrl(repoPath: string, name: string, url: string): void {
    cp.execFileSync(TestRepo.getJjBinary(), ['git', 'remote', 'set-url', name, url], {
        cwd: repoPath,
        stdio: 'ignore',
    });
}

async function switchColorTheme(page: Page, themeId: 'github-light' | 'pierre-dark-soft'): Promise<void> {
    await page.keyboard.press('Control+Shift+P');
    const paletteInput = page.locator('[data-testid="quick-input-text-input"]');
    await paletteInput.waitFor({ state: 'visible' });
    await paletteInput.fill('Color Theme');
    await page.locator('[data-testid="quick-pick-item-workbench.action.selectTheme"]').click();
    await paletteInput.fill(themeId);
    await page.locator(`[data-testid="quick-pick-item-${themeId}"]`).click();
    const expectedClass = themeId === 'github-light' ? /\bvscode-light\b/ : /\bvscode-dark\b/;
    await expect(page.locator('body')).toHaveClass(expectedClass);
}

async function rightClickWithCursor(
    rec: { moveTo: (target: Locator, frames?: number) => Promise<void>; hover: (frames?: number) => Promise<void> },
    target: Locator,
): Promise<void> {
    await rec.moveTo(target, 16);
    await rec.hover(4);
    await target.click({ button: 'right' });
    await rec.hover(6);
}

nonColocatedTest.describe('Remote File Links E2E (#670)', () => {
    nonColocatedTest(
        'copies and opens remote file links from SCM, Commit Details, and Diff Editor in dark & light themes',
        async ({ context, page, server, testRepo }) => {
            fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
            await context.grantPermissions(['clipboard-read', 'clipboard-write']);

            const pageErrors: string[] = [];
            page.on('pageerror', (err) => {
                const isExpectedAgentApiUnavailable =
                    err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
                if (!isExpectedAgentApiUnavailable) {
                    pageErrors.push(err.message);
                }
            });

            // Capture external URL launches cleanly without opening background tabs
            await page.addInitScript(() => {
                const opened: string[] = [];
                window.__OPENED_EXTERNAL_URLS__ = opened;
                window.open = (url?: string | URL) => {
                    if (url !== undefined) {
                        opened.push(String(url));
                    }
                    return null;
                };
            });

            // Verify non-colocated repository layout (.git does not live at workspace root)
            expect(fs.existsSync(path.join(testRepo.path, '.git'))).toBe(false);

            const bareRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-e2e-bare-remote-'));
            try {
                cp.execFileSync(TestRepo.getGitBinary(), ['init', '--bare', bareRemoteDir], {
                    stdio: 'ignore',
                });

                testRepo.addRemote('origin', bareRemoteDir);
                testRepo.writeFile(
                    'src/hello.ts',
                    [
                        'export function greet(name: string): string {',
                        '    const greeting = "Hello, " + name + "!";',
                        '    console.log(greeting);',
                        '    return greeting;',
                        '}',
                        '',
                    ].join('\n'),
                );
                testRepo.describe('feat: pushed initial module');
                testRepo.bookmark('main', '@');
                const pushedCommitSha = testRepo.getCommitId('@');
                testRepo.gitPush('main');

                // Set GitHub web-resolvable remote URL after pushing so main@origin records pushedCommitSha
                setRemoteUrl(testRepo.path, 'origin', 'https://github.com/acme/jj-view-demo.git');

                // Create unpushed commit + working copy edits modifying the tracked file
                testRepo.new(undefined, 'feat: unpushed intermediate commit');
                testRepo.writeFile('src/notes.md', '# Local notes\n');

                testRepo.new(undefined, 'wip: local working copy edits');
                testRepo.writeFile(
                    'src/hello.ts',
                    [
                        'export function greet(name: string): string {',
                        '    const trimmed = name.trim();',
                        '    const greeting = "Hello, " + trimmed + "!";',
                        '    console.log(greeting);',
                        '    return greeting;',
                        '}',
                        '',
                    ].join('\n'),
                );

                await page.goto(server.serverUrl);
                await waitForScmReady(page);

                // Dismiss initial GitHub PAT prompt once it appears so toast notifications & HUD are clean
                const skipAuthBtn = page.getByRole('button', { name: "Don't Sign In (Skip)" });
                try {
                    await skipAuthBtn.waitFor({ state: 'visible', timeout: 5000 });
                    await skipAuthBtn.click();
                    await expect(skipAuthBtn).toBeHidden();
                } catch {
                    // Prompt may not appear if auth detection settles differently
                }

                const expectedBaseFileUrl = `https://github.com/acme/jj-view-demo/blob/${pushedCommitSha}/src/hello.ts`;

                await recordInteractionFlow(
                    page,
                    {
                        gifPath: path.join(ARTIFACT_DIR, 'remote-file-links-demo.gif'),
                        mp4Path: path.join(ARTIFACT_DIR, 'remote-file-links-demo.mp4'),
                        fps: 24,
                        scale: 1280,
                    },
                    async (rec) => {
                        await rec.setHud('Non-colocated repo: copy link from SCM');
                        await rec.hover(10);

                        // 1. Copy Remote File Link from Working Changes in SCM (dark theme)
                        const wcGroup = page.locator('[data-testid="scm-group-working-copy"]');
                        const wcFileItem = wcGroup.locator('[data-testid="scm-resource-item"]', {
                            hasText: 'hello.ts',
                        });
                        await expect(wcFileItem).toBeVisible();
                        await rightClickWithCursor(rec, wcFileItem);

                        const contextMenu = page.locator('[data-testid="context-menu"]');
                        await expect(contextMenu).toBeVisible();
                        const scmOpenItem = contextMenu.locator('[data-testid="menu-item-jj-view.openFileOnRemote"]');
                        const scmCopyItem = contextMenu.locator('[data-testid="menu-item-jj-view.copyRemoteFileUrl"]');
                        await expect(scmOpenItem).toBeVisible();
                        await expect(scmCopyItem).toBeVisible();

                        await rec.moveTo(scmCopyItem, 14);
                        await rec.hover(6);
                        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'remote-file-links-dark.png') });
                        await rec.click(scmCopyItem, 4);

                        await expect
                            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
                            .toBe(expectedBaseFileUrl);

                        await rec.setHud('Commit Details: copy & open remote link');
                        await rec.hover(8);

                        // 2. Open Commit Details for the pushed commit and test file context menu
                        const pushedRow = page.locator('[data-testid="log-content"] .commit-row', {
                            hasText: 'feat: pushed initial module',
                        });
                        await expect(pushedRow).toBeVisible();
                        await rec.click(pushedRow.locator('.commit-desc'), 4);

                        const detailsView = page.locator('[data-testid="commit-details-view"]');
                        await expect(detailsView).toBeVisible();
                        const detailsFileRow = detailsView.locator('.file-row[data-file-path="src/hello.ts"]');
                        await expect(detailsFileRow).toBeVisible();

                        await rightClickWithCursor(rec, detailsFileRow);
                        const detailsMenu = page.locator('[data-testid="commit-details-file-context-menu"]');
                        await expect(detailsMenu).toBeVisible();
                        const detailsOpenBtn = detailsMenu.locator('[data-testid="details-open-file-on-remote"]');
                        const detailsCopyBtn = detailsMenu.locator('[data-testid="details-copy-remote-file-url"]');
                        await expect(detailsOpenBtn).toBeVisible();
                        await expect(detailsCopyBtn).toBeVisible();

                        await rec.click(detailsOpenBtn, 4);
                        await expect
                            .poll(() => page.evaluate(() => window.__OPENED_EXTERNAL_URLS__ ?? []))
                            .toEqual([expectedBaseFileUrl]);

                        // 3. Switch to Light Theme, open Diff Editor, select lines, copy link with #L range
                        await rec.setHud('Light theme: Diff editor line link');
                        await switchColorTheme(page, 'github-light');

                        await rec.click(wcFileItem, 4);
                        const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
                        await expect(diffViewer).toBeVisible();
                        const diffContainer = diffViewer.locator('[data-testid="diff-content-container"]');
                        await expect(diffContainer).toBeVisible();

                        // Select lines 2..3 via Pierre's additions-side line number gutter
                        const line2Gutter = diffViewer.locator('[data-additions] [data-column-number="2"]').first();
                        const line3Gutter = diffViewer.locator('[data-additions] [data-column-number="3"]').first();
                        await expect(line2Gutter).toBeVisible();
                        await expect(line3Gutter).toBeVisible();

                        await rec.click(line2Gutter, 4);
                        await rec.moveTo(line3Gutter, 12);
                        await line3Gutter.click({ modifiers: ['Shift'] });
                        await rec.hover(6);

                        const targetSelectedLine = diffViewer.locator('[data-additions] [data-line="2"]').first();
                        await expect(targetSelectedLine).toBeVisible();
                        const lineBox = await targetSelectedLine.boundingBox();
                        if (lineBox) {
                            const clickX = lineBox.x + Math.min(80, Math.max(12, lineBox.width * 0.25));
                            const clickY = lineBox.y + lineBox.height / 2;
                            await rec.moveToPoint(clickX, clickY, 16);
                            await rec.hover(4);
                            await page.mouse.click(clickX, clickY, { button: 'right' });
                            await rec.hover(6);
                        } else {
                            await rightClickWithCursor(rec, targetSelectedLine);
                        }
                        await expect(contextMenu).toBeVisible();
                        const editorCopyItem = contextMenu.locator(
                            '[data-testid="menu-item-jj-view.copyRemoteFileUrl"]',
                        );
                        await expect(editorCopyItem).toBeVisible();
                        await rec.moveTo(editorCopyItem, 14);
                        await rec.hover(6);
                        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'remote-file-links-light.png') });
                        await rec.click(editorCopyItem, 4);

                        await expect
                            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
                            .toBe(`${expectedBaseFileUrl}#L2-L3`);

                        // 4. Verify Command Palette invocation on active diff editor preserves #L range
                        await page.evaluate(() => navigator.clipboard.writeText(''));
                        await page.keyboard.press('Control+Shift+P');
                        const paletteInput = page.locator('[data-testid="quick-input-text-input"]');
                        await paletteInput.waitFor({ state: 'visible' });
                        await paletteInput.fill('Copy Remote File Link');
                        const paletteCopyItem = page.locator(
                            '[data-testid="quick-pick-item-jj-view.copyRemoteFileUrl"]',
                        );
                        await expect(paletteCopyItem).toBeVisible();
                        await rec.click(paletteCopyItem, 4);
                        await expect
                            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
                            .toBe(`${expectedBaseFileUrl}#L2-L3`);

                        await rec.hover(10);
                    },
                );

                expect(pageErrors).toEqual([]);
            } finally {
                fs.rmSync(bareRemoteDir, { recursive: true, force: true });
            }
        },
    );
});
