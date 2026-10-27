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

    test('should auto-collapse empty repositories and auto-expand on dirty transitions', async ({
        page,
        server,
        testRepo,
    }) => {
        // Create root repo commit and dirty working copy so the workspace is multi-repo
        testRepo.writeFile('root_file.txt', 'root content\n');
        testRepo.describe('root commit');
        testRepo.new();
        testRepo.writeFile('root_dirty.txt', 'uncommitted root change\n');

        // Create a subproject that has ONLY an empty working copy on root() (no mutable ancestors, no changes)
        const cleanSubPath = path.join(testRepo.path, 'clean_sub');
        const cleanSubRepo = new ScopedTestRepo(cleanSubPath);
        cleanSubRepo.init();

        try {
            await page.goto(server.serverUrl);
            await waitForScmReady(page);

            // Wait for repositoryManager to complete recursive scanning and discover both repositories
            await page.waitForFunction(
                () => {
                    const manager = window.__JJ_VIEW_REPO_MANAGER__;
                    return manager && manager.repositories.length >= 2;
                },
                { timeout: 10000 },
            );

            const cleanSection = page.locator('[data-testid="scm-repository-section"]', {
                hasText: 'clean_sub',
            });
            const cleanHeader = cleanSection.getByTestId('scm-repository-header');

            // 1. Initial state: clean_sub has only an empty working copy, so it should be auto-collapsed
            await expect(cleanHeader).toHaveAttribute('aria-expanded', 'false');
            await expect(cleanSection.locator('[data-testid="scm-group-working-copy"]')).toHaveCount(0);

            // Manually expand clean_sub while it is still empty and verify manual toggle is preserved across refreshes
            await cleanHeader.click();
            await expect(cleanHeader).toHaveAttribute('aria-expanded', 'true');

            await page.evaluate(async () => {
                const manager = window.__JJ_VIEW_REPO_MANAGER__;
                if (manager) {
                    await Promise.all(manager.repositories.map((r) => r.refresh({ forceSnapshot: true })));
                }
            });
            await expect(cleanHeader).toHaveAttribute('aria-expanded', 'true');

            // Manually collapse clean_sub back before testing the auto-expand dirty transition
            await cleanHeader.click();
            await expect(cleanHeader).toHaveAttribute('aria-expanded', 'false');

            // 2. Add a new file in clean_sub so it becomes dirty
            cleanSubRepo.writeFile('new_file.txt', 'new sub content\n');

            // Refresh repositories
            await page.evaluate(async () => {
                const manager = window.__JJ_VIEW_REPO_MANAGER__;
                if (manager) {
                    await Promise.all(manager.repositories.map((r) => r.refresh({ forceSnapshot: true })));
                }
            });

            // clean_sub should auto-expand and show the modified/added file
            await expect(cleanHeader).toHaveAttribute('aria-expanded', 'true');
            const cleanWorkingCopy = cleanSection.locator('[data-testid="scm-group-working-copy"]');
            await expect(cleanWorkingCopy).toBeVisible();
            await expect(cleanSection.getByTestId('scm-resource-item')).toContainText('new_file.txt');

            // 3. Restore/delete the file so clean_sub returns to only an empty working copy
            cleanSubRepo.deleteFile('new_file.txt');

            // Refresh repositories
            await page.evaluate(async () => {
                const manager = window.__JJ_VIEW_REPO_MANAGER__;
                if (manager) {
                    await Promise.all(manager.repositories.map((r) => r.refresh({ forceSnapshot: true })));
                }
            });

            // clean_sub should auto-collapse again
            await expect(cleanHeader).toHaveAttribute('aria-expanded', 'false');
            await expect(cleanSection.locator('[data-testid="scm-group-working-copy"]')).toHaveCount(0);
        } finally {
            cleanSubRepo.dispose();
        }
    });
});
