/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { buildGraph } from '../test-repo';
import { ARTIFACT_DIR, expect, recordGifFlow, test, waitForScmReady } from './standalone-fixture';

test.describe('Standalone Web 3-Way Merge Editor', () => {
    test('should support auto-merging, smart token combination, gutter checkboxes, Append/Ignore/Handled actions, and Complete Merge', async ({
        page,
        server,
        testRepo,
    }) => {
        const baseFile = [
            'import { core } from "./core";',
            'const VERSION = 1;',
            'export function connect(host = "localhost", port = 8080) {',
            '  return host + ":" + port;',
            '}',
            'const settings = {',
            '  mode: "default",',
            '  retries: 3,',
            '};',
            'export default settings;',
            '',
        ].join('\n');

        const branch1File = [
            'import { core } from "./core";',
            'import { leftPlugin } from "./left-plugin";',
            'const VERSION = 1;',
            'export function connect(host = "0.0.0.0", port = 8080) {',
            '  return host + ":" + port;',
            '}',
            'const settings = {',
            '  mode: "fast-left",',
            '  retries: 3,',
            '};',
            'export default settings;',
            '',
        ].join('\n');

        const branch2File = [
            'import { core } from "./core";',
            'const VERSION = 1;',
            'export function connect(host = "localhost", port = 9090) {',
            '  return host + ":" + port;',
            '}',
            'const settings = {',
            '  mode: "safe-right",',
            '  retries: 3,',
            '};',
            'export const extraRightFlag = true;',
            'export default settings;',
            '',
        ].join('\n');

        await buildGraph(testRepo, [
            { label: 'base', description: 'base commit', files: { 'merge-conflict.ts': baseFile } },
            {
                label: 'branch1',
                parents: ['base'],
                description: 'branch 1 (left)',
                files: { 'merge-conflict.ts': branch1File },
            },
            {
                label: 'branch2',
                parents: ['base'],
                description: 'branch 2 (right)',
                files: { 'merge-conflict.ts': branch2File },
            },
            {
                label: 'merge',
                parents: ['branch1', 'branch2'],
                description: 'merge commit with conflict',
                isCurrentWorkingCopy: true,
            },
        ]);

        await recordGifFlow(
            page,
            async (captureFrame) => {
                await page.goto(server.serverUrl);
                await waitForScmReady(page);

                // Verify Merge Conflicts group is present
                const conflictsGroup = page.locator('[data-testid="scm-group-conflicts"]');
                await expect(conflictsGroup).toBeVisible({ timeout: 5000 });

                const conflictItem = conflictsGroup
                    .locator('[data-testid="scm-resource-item"]')
                    .filter({ hasText: 'merge-conflict.ts' });
                await expect(conflictItem).toBeVisible();
                await captureFrame();

                await conflictItem.click();

                // Verify 3-Way Merge Editor mounts
                const mergeEditor = page.locator('[data-testid="merge-editor-view"]');
                await expect(mergeEditor).toBeVisible({ timeout: 5000 });

                // 2 non-overlapping changes auto-merged (Left import + Right export), 2 conflicts remaining
                const conflictCounter = mergeEditor.locator('[data-testid="merge-conflict-counter"]');
                await expect(conflictCounter).toHaveText('2 conflicts remaining');

                const autoMergedCounter = mergeEditor.locator('[data-testid="merge-automerged-counter"]');
                await expect(autoMergedCounter).toHaveText('2 auto-merged');

                // Verify intra-line word diff highlights are rendered
                await expect(mergeEditor.locator('[data-testid="merge-word-diff"]').first()).toBeVisible();

                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'merge-editor-conflict.png') });
                await captureFrame();

                // Toggle Base column on and verify it renders
                const toggleBaseBtn = mergeEditor.locator('[data-testid="merge-toggle-base"]');
                await toggleBaseBtn.click();
                await expect(mergeEditor.locator('[data-testid="merge-header-base"]')).toBeVisible();
                await expect(mergeEditor.locator('[data-testid="merge-base-hunk-1"]')).toContainText('mode: "default"');
                await captureFrame();

                // Toggle Base column off
                await toggleBaseBtn.click();
                await expect(mergeEditor.locator('[data-testid="merge-header-base"]')).toHaveCount(0);

                // Conflict #0 (connect signature): Left changed host="0.0.0.0", Right changed port=9090 on the same line.
                // Order is not relevant (token-level smart merge), so button says "Accept Combination".
                const combineBtn0 = mergeEditor.locator('[data-testid="merge-accept-both-left-0"]');
                await expect(combineBtn0).toHaveText('Accept Combination');
                await combineBtn0.click();

                await expect(mergeEditor.locator('[data-testid="merge-hunk-editor-0"]')).toHaveValue(
                    'export function connect(host = "0.0.0.0", port = 9090) {',
                );
                await expect(conflictCounter).toHaveText('1 conflict remaining');
                await captureFrame();

                // Conflict #1 (mode property): test gutter checkboxes, Accept -> Append transition, and Ignore/Handled
                const leftCheckbox1 = mergeEditor.locator('[data-testid="merge-checkbox-left-1"]');
                const rightPrimaryBtn1 = mergeEditor.locator('[data-testid="merge-accept-right-1"]');

                await leftCheckbox1.click();
                await expect(conflictCounter).toHaveText('All conflicts resolved');
                await expect(mergeEditor.locator('[data-testid="merge-hunk-editor-1"]')).toHaveValue(
                    '  mode: "fast-left",',
                );
                // Because Left is accepted, Right's primary action now says "Append Right" (VS Code parity)
                await expect(rightPrimaryBtn1).toHaveText('Append Right');
                await captureFrame();

                // Click "Append Right" to combine Left followed by Right
                await rightPrimaryBtn1.click();
                await expect(mergeEditor.locator('[data-testid="merge-hunk-editor-1"]')).toHaveValue(
                    '  mode: "fast-left",\n  mode: "safe-right",',
                );
                await captureFrame();

                // Test "Reset to Base" and "Mark as Handled" (keeping Base while resolving conflict count)
                await mergeEditor.locator('[data-testid="merge-result-reset-1"]').click();
                await expect(conflictCounter).toHaveText('1 conflict remaining');
                await mergeEditor.locator('[data-testid="merge-result-toggle-handled-1"]').click();
                await expect(conflictCounter).toHaveText('All conflicts resolved');
                await expect(mergeEditor.locator('[data-testid="merge-result-status-1"]')).toContainText(
                    'No Changes Accepted (Handled)',
                );

                // Accept Left on Conflict #1 for final output
                await mergeEditor.locator('[data-testid="merge-accept-left-1"]').click();
                await expect(mergeEditor.locator('[data-testid="merge-hunk-editor-1"]')).toHaveValue(
                    '  mode: "fast-left",',
                );
                await page.screenshot({ path: path.join(ARTIFACT_DIR, 'merge-editor-resolved.png') });
                await captureFrame();

                // Verify switching to 2-Way Diff and back works
                await mergeEditor.locator('[data-testid="merge-open-2way-diff"]').click();
                const diffViewer = page.locator('[data-testid="pierre-diff-viewer"]');
                await expect(diffViewer).toBeVisible({ timeout: 5000 });
                const openMergeBtn = diffViewer.locator('[data-testid="diff-open-merge-editor-btn"]');
                await expect(openMergeBtn).toBeVisible();
                await openMergeBtn.click();

                await expect(mergeEditor).toBeVisible();
                await mergeEditor.locator('[data-testid="merge-accept-both-left-0"]').click();
                await mergeEditor.locator('[data-testid="merge-accept-left-1"]').click();
                await expect(conflictCounter).toHaveText('All conflicts resolved');

                const completeBtn = mergeEditor.locator('[data-testid="merge-complete-btn"]');
                await completeBtn.click();
                await captureFrame();
            },
            { outputPath: path.join(ARTIFACT_DIR, 'merge-editor-flow.gif') },
        );

        // Merge Conflicts group should disappear once resolved
        await expect(page.locator('[data-testid="scm-group-conflicts"]')).toHaveCount(0, { timeout: 5000 });

        // Verify disk content contains auto-merged Left import, smart-combined connect(), resolved Left mode, and auto-merged Right export
        const resolvedDiskContent = testRepo.getFileContent('@', 'merge-conflict.ts');
        expect(resolvedDiskContent).toBe(
            [
                'import { core } from "./core";',
                'import { leftPlugin } from "./left-plugin";',
                'const VERSION = 1;',
                'export function connect(host = "0.0.0.0", port = 9090) {',
                '  return host + ":" + port;',
                '}',
                'const settings = {',
                '  mode: "fast-left",',
                '  retries: 3,',
                '};',
                'export const extraRightFlag = true;',
                'export default settings;',
                '',
            ].join('\n'),
        );
    });

    test('should bidirectionally sync manual edits in Result editor with conflict state and preserve edits across mode switches', async ({
        page,
        server,
        testRepo,
    }) => {
        await buildGraph(testRepo, [
            { label: 'base', description: 'base', files: { 'config.ts': 'const header = 1;\nconst val = 0;\n' } },
            {
                label: 'left',
                parents: ['base'],
                description: 'left',
                files: { 'config.ts': 'const header = 1;\nconst val = 10;\n' },
            },
            {
                label: 'right',
                parents: ['base'],
                description: 'right',
                files: { 'config.ts': 'const header = 1;\nconst val = 20;\n' },
            },
            {
                label: 'merge',
                parents: ['left', 'right'],
                description: 'merge',
                isCurrentWorkingCopy: true,
            },
        ]);

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        const conflictItem = page
            .locator('[data-testid="scm-group-conflicts"] [data-testid="scm-resource-item"]')
            .filter({ hasText: 'config.ts' });
        await conflictItem.click();

        const mergeEditor = page.locator('[data-testid="merge-editor-view"]');
        await expect(mergeEditor).toBeVisible();

        const hunkEditor = mergeEditor.locator('[data-testid="merge-hunk-editor-0"]');
        await hunkEditor.fill('const val = 99;');

        // Status should automatically update to Manual Resolution and conflict count to 0
        await expect(mergeEditor.locator('[data-testid="merge-result-status-0"]')).toContainText('Manual Resolution');
        await expect(mergeEditor.locator('[data-testid="merge-conflict-counter"]')).toHaveText(
            'All conflicts resolved',
        );
        await expect(mergeEditor.locator('[data-testid="merge-checkbox-left-0"]')).toHaveText('●');

        // Switch to Full Result Editor, edit clean header line, and switch back
        const toggleRawBtn = mergeEditor.locator('[data-testid="merge-toggle-raw-edit"]');
        await toggleRawBtn.click();
        const rawTextarea = mergeEditor.locator('[data-testid="merge-raw-textarea"]');
        await expect(rawTextarea).toHaveValue('const header = 1;\nconst val = 99;\n');
        await rawTextarea.fill('const header = 2;\nconst val = 99;\n');

        // Switch back to Structured Result View and click Accept Left on the hunk:
        // the clean header edit ("const header = 2;") must NOT be overwritten!
        await toggleRawBtn.click();
        await mergeEditor.locator('[data-testid="merge-accept-left-0"]').click();
        await mergeEditor.locator('[data-testid="merge-complete-btn"]').click();

        await expect(page.locator('[data-testid="scm-group-conflicts"]')).toHaveCount(0, { timeout: 5000 });
        expect(testRepo.getFileContent('@', 'config.ts')).toBe('const header = 2;\nconst val = 10;\n');
    });
});
