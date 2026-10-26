/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { ScopedTestRepo } from '../test-repo';
import { ARTIFACT_DIR, expect, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web Multirepo Workspace', () => {
    test('should recursively discover nested sub-repositories using host fastwalk findFiles', async ({
        page,
        server,
        testRepo,
    }) => {
        // Create root repo commit
        testRepo.writeFile('root_file.txt', 'root content\n');
        testRepo.describe('root commit');
        testRepo.new();

        // Create subprojects nested at different directory levels
        const sub1Path = path.join(testRepo.path, 'subproject1');
        const sub2Path = path.join(testRepo.path, 'nested', 'subproject2');

        const sub1Repo = new ScopedTestRepo(sub1Path);
        sub1Repo.init();
        sub1Repo.writeFile('sub1_file.txt', 'sub1 content\n');
        sub1Repo.describe('sub1 commit');
        sub1Repo.new();

        sub1Repo.writeFile('sub1_dirty.txt', 'uncommitted sub1 change\n');

        const sub2Repo = new ScopedTestRepo(sub2Path);
        sub2Repo.init();
        sub2Repo.writeFile('sub2_file.txt', 'sub2 content\n');
        sub2Repo.describe('sub2 commit');
        sub2Repo.new();
        sub2Repo.writeFile('sub2_dirty.txt', 'uncommitted sub2 change\n');

        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            // Wait for repositoryManager to complete recursive scanning and discover all repositories
            await page.waitForFunction(
                () => {
                    const manager = window.__JJ_VIEW_REPO_MANAGER__;
                    return manager && manager.repositories.length >= 3;
                },
                { timeout: 10000 },
            );

            // Query discovered repository roots from repoManager
            const discoveredRoots = await page.evaluate((): string[] => {
                const manager = window.__JJ_VIEW_REPO_MANAGER__;
                return manager ? manager.repositories.map((r) => r.rootUri.fsPath) : [];
            });

            // Normalize path separators for cross-platform matching
            const normDiscovered = discoveredRoots.map((p: string) => p.replace(/[\\/]+/g, '/'));
            const normRoot = testRepo.path.replace(/[\\/]+/g, '/');
            const normSub1 = sub1Path.replace(/[\\/]+/g, '/');
            const normSub2 = sub2Path.replace(/[\\/]+/g, '/');

            expect(normDiscovered).toContain(normRoot);
            expect(normDiscovered).toContain(normSub1);
            expect(normDiscovered).toContain(normSub2);

            // Verify multi-repository SCM sections are rendered with each repository's working copy changes
            const repoSections = page.getByTestId('scm-repository-section');
            await expect(repoSections).toHaveCount(3);
            await expect(page.getByTestId('scm-pane')).toContainText('subproject1');
            await expect(page.getByTestId('scm-pane')).toContainText('subproject2');
            await expect(page.getByTestId('scm-pane')).toContainText('sub1_dirty.txt');
            await expect(page.getByTestId('scm-pane')).toContainText('sub2_dirty.txt');

            // Click "Show Repository in JJ Log" on subproject1 and verify focusedRepository updates
            const sub1Section = page.locator('[data-testid="scm-repository-section"]', {
                hasText: 'subproject1',
            });
            await sub1Section.getByTestId('scm-title-action-jj-view.focusRepository').click();
            await expect(sub1Section.getByTestId('scm-repository-focused-badge')).toBeVisible();
            await expect(page.getByTestId('log-pane')).toContainText('sub1 commit');

            // Capture screenshot for walkthrough
            await page.screenshot({
                path: path.join(ARTIFACT_DIR, 'multirepo-workspace-discovery.png'),
                fullPage: true,
            });
        } finally {
            sub1Repo.dispose();
            sub2Repo.dispose();
        }
    });
});
