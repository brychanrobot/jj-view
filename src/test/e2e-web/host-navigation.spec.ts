/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Host Navigation & Multi-Diff', () => {
    test('openMultiDiff routes diffs to viewer and records interactive visual flow', async ({
        page,
        server,
        testRepo,
    }) => {
        testRepo.writeFile(
            'feature-a-base.txt',
            'function calculate() {\n  const initial = 10;\n  return initial * 2;\n}\n',
        );
        testRepo.writeFile(
            'feature-a.txt',
            'function calculate() {\n  const initial = 25;\n  const multiplier = 4;\n  return initial * multiplier;\n}\n',
        );
        testRepo.writeFile('feature-b-base.txt', 'export const config = {\n  debug: false,\n};\n');
        testRepo.writeFile('feature-b.txt', 'export const config = {\n  debug: true,\n  env: "production",\n};\n');

        const secondaryRepo = testRepo.workspaceAdd('secondary-workspace');
        secondaryRepo.writeFile('workspace-info.txt', 'Secondary workspace repository\n');
        secondaryRepo.describe('feat: secondary repository workspace');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const gifPath = path.join(ARTIFACT_DIR, 'host-navigation-flow.gif');
        const multiDiffPngPath = path.join(ARTIFACT_DIR, 'multi-diff-viewer.png');
        const folderPngPath = path.join(ARTIFACT_DIR, 'folder-navigation-view.png');

        await recordGifFlow(
            page,
            async (captureFrame) => {
                // Frame 1: Initial workspace view
                await captureFrame();

                // Frame 2: Trigger openMultiDiff via HostNavigation
                await page.evaluate(
                    ({ repoPath }) => {
                        const env = window.__JJ_VIEW_ENV__;
                        if (!env) {
                            return;
                        }
                        const makeUri = (p: string): import('../../core/uri-utils').Uri => ({
                            scheme: 'file',
                            path: p,
                            fsPath: p,
                            authority: '',
                            query: '',
                            fragment: '',
                            toString: () => `file://${p}`,
                            toJSON: () => ({
                                scheme: 'file',
                                path: p,
                                fsPath: p,
                                authority: '',
                                query: '',
                                fragment: '',
                            }),
                            with: () => makeUri(p),
                        });

                        const fileABase = `${repoPath}/feature-a-base.txt`;
                        const fileAPath = `${repoPath}/feature-a.txt`;
                        const fileBBase = `${repoPath}/feature-b-base.txt`;
                        const fileBPath = `${repoPath}/feature-b.txt`;
                        void env.nav.openMultiDiff('Multi-Diff Set', [
                            {
                                leftUri: makeUri(fileABase),
                                rightUri: makeUri(fileAPath),
                                label: 'feature-a.txt',
                            },
                            {
                                leftUri: makeUri(fileBBase),
                                rightUri: makeUri(fileBPath),
                                label: 'feature-b.txt',
                            },
                        ]);
                    },
                    { repoPath: testRepo.path },
                );

                const multiDiffViewer = page.locator('[data-testid="pierre-multi-diff-viewer"]');
                await expect(multiDiffViewer).toBeVisible({ timeout: 10000 });
                const activeTab = page.locator('[data-testid="tab-bar-container"] .tab.active');
                await expect(activeTab).toContainText('Multi-Diff Set');

                const diffContainer = multiDiffViewer.locator('[data-testid="multi-diff-content-container"]');
                await expect(diffContainer).toBeVisible({ timeout: 10000 });

                // Verify BOTH files are simultaneously rendered on screen
                await expect(diffContainer.getByText('const multiplier = 4;')).toBeVisible({ timeout: 8000 });
                await expect(diffContainer.getByText('env: "production"')).toBeVisible({ timeout: 8000 });
                await expect(diffContainer.getByText('feature-a.txt')).toBeVisible({ timeout: 8000 });
                await expect(diffContainer.getByText('feature-b.txt')).toBeVisible({ timeout: 8000 });

                await page.screenshot({ path: multiDiffPngPath });
                await captureFrame();

                // Frame 3: Toggle unified diff across all files in multi-diff
                const unifiedBtn = multiDiffViewer.locator('[data-testid="toggle-unified-diff"]');
                await expect(unifiedBtn).toBeVisible();
                await unifiedBtn.click();
                await expect(unifiedBtn).toHaveClass(/active/);
                await captureFrame();

                // Frame 4: Toggle back to split diff across all files in multi-diff
                const splitBtn = multiDiffViewer.locator('[data-testid="toggle-split-diff"]');
                await expect(splitBtn).toBeVisible();
                await splitBtn.click();
                await expect(splitBtn).toHaveClass(/active/);
                await captureFrame();

                // Frame 5: Navigate folder via openFolder with ?repo=
                const newUrl = `${server.serverUrl}&repo=${encodeURIComponent(secondaryRepo.path)}`;
                await page.goto(newUrl);
                await waitForScmReady(page);

                const statusBar = page.locator('[data-testid="status-bar"]');
                await expect(statusBar).toBeVisible({ timeout: 10000 });
                await page.screenshot({ path: folderPngPath });
                await captureFrame();
            },
            {
                outputPath: gifPath,
                framerate: 1.2,
                scale: 960,
            },
        );
    });
});
