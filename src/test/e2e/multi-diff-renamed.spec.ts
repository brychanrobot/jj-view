/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { buildGraph, TestRepo } from '../test-repo';
import {
    clickScmAction,
    focusJJLog,
    focusSCM,
    rightClickAndSelect,
    SCM_ACTIONS,
    test,
    waitForLogCommitRow,
    waitForTab,
} from './e2e-helpers';

interface MultiDiffEntryInfo {
    modifiedLabel: string;
    description: string;
    originalText: string;
    statusText: string;
    isRenamed: boolean;
}

interface ExpectedMultiDiffEntry {
    modifiedLabel: string;
    descriptionContains?: string;
    allowExternalPath?: boolean;
    isRenamed: boolean;
    originalText?: string;
}

const SHARED_RENAME_LINES = [
    'export const legacyHeader = "module";',
    'export const item1 = "alpha";',
    'export const item2 = "beta";',
    'export const item3 = "gamma";',
    'export const item4 = "delta";',
    'export const item5 = "epsilon";',
    'export const item6 = "zeta";',
    'export const item7 = "eta";',
    'export const item8 = "theta";',
    'export const item9 = "omega";',
].join('\n');

const INITIAL_CLI_UTIL = ['pub fn load_config() -> bool {', '    println!("v1");', '    true', '}'].join('\n');

const MODIFIED_CLI_UTIL = ['pub fn load_config() -> bool {', '    println!("v2");', '    true', '}'].join('\n');

async function readMultiDiffEntries(page: Page): Promise<MultiDiffEntryInfo[]> {
    return await page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLElement>('.multiDiffEntry'))
            .filter((entry) => entry.offsetParent !== null && entry.getBoundingClientRect().height > 0)
            .map((entry) => {
                const modifiedLabel =
                    entry.querySelector('.file-path .title.modified .label-name')?.textContent?.trim() ?? '';
                const description =
                    entry.querySelector('.file-path .title.modified .label-description')?.textContent?.trim() ?? '';
                const originalText =
                    entry.querySelector('.file-path .title.original .label-name')?.textContent?.trim() ?? '';
                const statusEl = entry.querySelector('.file-path .status');
                const statusText = statusEl?.textContent?.trim() ?? '';
                const isRenamed = statusEl?.classList.contains('renamed') ?? false;
                return {
                    modifiedLabel,
                    description,
                    originalText,
                    statusText,
                    isRenamed,
                };
            });
    });
}

async function waitForVisibleMultiDiff(page: Page): Promise<void> {
    await expect(page.locator('.multiDiffEntry .monaco-diff-editor:visible').first()).toBeVisible({
        timeout: 15000,
    });
}

async function expectMultiDiffEntryStates(page: Page, expected: ExpectedMultiDiffEntry[]): Promise<void> {
    await expect
        .poll(
            async () => {
                const entries = await readMultiDiffEntries(page);
                if (entries.length < expected.length) {
                    return { ok: false, reason: 'count-mismatch', entries };
                }
                const allMatch = expected.every((exp) => {
                    const match = entries.find((entry) => entry.modifiedLabel === exp.modifiedLabel);
                    if (!match) {
                        return false;
                    }
                    if (!exp.allowExternalPath && match.description.startsWith('/')) {
                        return false;
                    }
                    if (
                        exp.descriptionContains &&
                        !match.description.replace(/\\/g, '/').includes(exp.descriptionContains)
                    ) {
                        return false;
                    }
                    if (match.isRenamed !== exp.isRenamed) {
                        return false;
                    }
                    if (exp.isRenamed) {
                        return match.statusText === 'R' && match.originalText === (exp.originalText ?? '');
                    }
                    return match.statusText === '' && match.originalText === '';
                });
                return { ok: allMatch, reason: allMatch ? 'ok' : 'mismatch', entries };
            },
            {
                timeout: 15000,
                message: 'Multi-diff entries did not match expected Modified vs Renamed headers',
            },
        )
        .toMatchObject({ ok: true });
}

async function captureFrames(page: Page, framesDir: string, startIndex: number, count: number): Promise<number> {
    let idx = startIndex;
    for (let i = 0; i < count; i++) {
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const framePath = path.join(framesDir, `frame_${String(idx).padStart(4, '0')}.png`);
        await page.screenshot({ path: framePath });
        idx += 1;
    }
    return idx;
}

test.describe('Multi-File Diff Modified vs Renamed (#655)', () => {
    test('Working copy multi-diff shows modified files as Modified and genuine renames as Renamed', async ({
        vscode,
    }) => {
        const repo = new TestRepo();
        const screenshotOutDir = process.env.SCREENSHOT_OUT_DIR;
        let framesDir: string | undefined;
        let changedTheme = false;

        try {
            repo.init();
            if (screenshotOutDir) {
                framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-multi-diff-frames-'));
            }
            await buildGraph(repo, [
                {
                    label: 'initial',
                    description: 'initial baseline',
                    files: {
                        'cli/src/cli_util.rs': INITIAL_CLI_UTIL,
                        'legacy/old_name.txt': SHARED_RENAME_LINES,
                    },
                },
                {
                    label: 'wc',
                    parents: ['initial'],
                    description: 'working copy edits',
                    isCurrentWorkingCopy: true,
                    files: {
                        'cli/src/cli_util.rs': MODIFIED_CLI_UTIL,
                        'modern/new_name.txt': `${SHARED_RENAME_LINES}\nexport const extra = "updated";`,
                    },
                },
            ]);
            repo.deleteFile('legacy/old_name.txt');

            const { page } = await vscode.openWorkspace(repo);
            await focusSCM(page);
            await expect(page.getByRole('treeitem', { name: /cli_util\.rs/ }).first()).toBeVisible({ timeout: 15000 });
            await expect(page.getByRole('treeitem', { name: /new_name\.txt/ }).first()).toBeVisible({ timeout: 15000 });

            let frameIdx = 0;
            if (framesDir) {
                frameIdx = await captureFrames(page, framesDir, frameIdx, 6);
            }

            await clickScmAction(page, /Working Copy/, SCM_ACTIONS.MultiFileDiff);
            await waitForTab(page, /working copy edits/);
            await waitForVisibleMultiDiff(page);

            await expectMultiDiffEntryStates(page, [
                {
                    modifiedLabel: 'cli_util.rs',
                    descriptionContains: 'cli/src',
                    isRenamed: false,
                },
                {
                    modifiedLabel: 'new_name.txt',
                    descriptionContains: 'modern',
                    isRenamed: true,
                    originalText: 'old_name.txt',
                },
            ]);

            if (screenshotOutDir && framesDir) {
                fs.mkdirSync(screenshotOutDir, { recursive: true });
                await page.evaluate(
                    () =>
                        new Promise<void>((resolve) =>
                            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                        ),
                );
                await page.screenshot({ path: path.join(screenshotOutDir, 'multi-diff-renamed-after-dark.png') });
                frameIdx = await captureFrames(page, framesDir, frameIdx, 12);
            }

            // Verify Light theme fidelity and capture optional light screenshot
            changedTheme = true;
            await vscode.evaluate(async (vs) => {
                await vs.workspace
                    .getConfiguration('workbench')
                    .update('colorTheme', 'Default Light Modern', vs.ConfigurationTarget.Global);
            });
            await expect(page.locator('.monaco-workbench.vs')).toBeVisible({ timeout: 10000 });
            await expectMultiDiffEntryStates(page, [
                {
                    modifiedLabel: 'cli_util.rs',
                    descriptionContains: 'cli/src',
                    isRenamed: false,
                },
                {
                    modifiedLabel: 'new_name.txt',
                    descriptionContains: 'modern',
                    isRenamed: true,
                    originalText: 'old_name.txt',
                },
            ]);

            if (screenshotOutDir && framesDir) {
                await page.evaluate(
                    () =>
                        new Promise<void>((resolve) =>
                            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                        ),
                );
                await page.screenshot({ path: path.join(screenshotOutDir, 'multi-diff-renamed-after-light.png') });
                frameIdx = await captureFrames(page, framesDir, frameIdx, 12);
                cp.execFileSync(
                    'ffmpeg',
                    [
                        '-y',
                        '-framerate',
                        '6',
                        '-i',
                        path.join(framesDir, 'frame_%04d.png'),
                        '-c:v',
                        'libx264',
                        '-pix_fmt',
                        'yuv420p',
                        '-vf',
                        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                        path.join(screenshotOutDir, 'multi-diff-renamed-after.mp4'),
                    ],
                    { stdio: 'pipe' },
                );
            }
        } finally {
            if (changedTheme) {
                await vscode
                    .evaluate(async (vs) => {
                        await vs.workspace
                            .getConfiguration('workbench')
                            .update('colorTheme', 'Default Dark Modern', vs.ConfigurationTarget.Global);
                    })
                    .catch(() => {});
            }
            if (framesDir) {
                fs.rmSync(framesDir, { recursive: true, force: true });
            }
            vscode.requestReset();
            await repo.dispose();
        }
    });

    test('Nested subrepo inside parent workspace shows modified files as Modified', async ({ vscode }) => {
        let parentWs: string | undefined;
        let subRepo: TestRepo | undefined;

        try {
            parentWs = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-parent-ws-'));
            subRepo = new TestRepo(path.join(parentWs, 'subrepo'));
            subRepo.init();
            await buildGraph(subRepo, [
                {
                    label: 'initial',
                    description: 'initial baseline',
                    files: {
                        'README.md': 'hello v1\n',
                        'cli/src/cli_util.rs': INITIAL_CLI_UTIL,
                    },
                },
                {
                    label: 'wc',
                    parents: ['initial'],
                    description: 'working copy edits',
                    isCurrentWorkingCopy: true,
                    files: {
                        'README.md': 'hello v2\n',
                        'cli/src/cli_util.rs': MODIFIED_CLI_UTIL,
                    },
                },
            ]);

            const { page } = await vscode.openWorkspace(
                { path: parentWs },
                { 'jj-view.autoRepositoryDetection': true },
                undefined,
                undefined,
                /* skipRepoSync= */ true,
            );

            await expect
                .poll(
                    async () => {
                        return await vscode.evaluate(async (_vs, api) => {
                            if (api.repositoryManager.repositories.length === 0) {
                                await api.repositoryManager.scanForRepositories();
                            }
                            return {
                                count: api.repositoryManager.repositories.length,
                                focused: Boolean(api.repositoryManager.focusedRepository),
                            };
                        });
                    },
                    { timeout: 15000 },
                )
                .toEqual({ count: 1, focused: true });

            await focusSCM(page);
            await expect(page.getByRole('treeitem', { name: /cli_util\.rs/ }).first()).toBeVisible({ timeout: 15000 });
            await expect(async () => {
                await clickScmAction(page, /Working Copy/, SCM_ACTIONS.MultiFileDiff);
                await waitForTab(page, /working copy edits/);
            }).toPass({ timeout: 20000 });
            await waitForVisibleMultiDiff(page);

            await expectMultiDiffEntryStates(page, [
                { modifiedLabel: 'README.md', descriptionContains: 'subrepo', isRenamed: false },
                { modifiedLabel: 'cli_util.rs', descriptionContains: 'subrepo/cli/src', isRenamed: false },
            ]);
        } finally {
            vscode.requestReset();
            await subRepo?.dispose();
            if (parentWs) {
                fs.rmSync(parentWs, { recursive: true, force: true });
            }
        }
    });

    test('Subfolder workspace inside repo shows modified files as Modified', async ({ vscode }) => {
        const repo = new TestRepo();

        try {
            repo.init();
            await buildGraph(repo, [
                {
                    label: 'initial',
                    description: 'initial baseline',
                    files: {
                        'root_notes.md': 'notes v1\n',
                        'cli/src/cli_util.rs': INITIAL_CLI_UTIL,
                    },
                },
                {
                    label: 'wc',
                    parents: ['initial'],
                    description: 'working copy edits',
                    isCurrentWorkingCopy: true,
                    files: {
                        'root_notes.md': 'notes v2\n',
                        'cli/src/cli_util.rs': MODIFIED_CLI_UTIL,
                    },
                },
            ]);

            const subFolder = path.join(repo.path, 'cli');
            const { page } = await vscode.openWorkspace(
                { path: subFolder },
                { 'jj-view.autoRepositoryDetection': true },
                undefined,
                undefined,
                /* skipRepoSync= */ true,
            );

            await expect
                .poll(
                    async () => {
                        return await vscode.evaluate(async (_vs, api) => {
                            if (api.repositoryManager.repositories.length === 0) {
                                await api.repositoryManager.scanForRepositories();
                            }
                            return {
                                count: api.repositoryManager.repositories.length,
                                focused: Boolean(api.repositoryManager.focusedRepository),
                            };
                        });
                    },
                    { timeout: 15000 },
                )
                .toEqual({ count: 1, focused: true });

            await focusSCM(page);
            await expect(page.getByRole('treeitem', { name: /cli_util\.rs/ }).first()).toBeVisible({ timeout: 15000 });
            await expect(async () => {
                await clickScmAction(page, /Working Copy/, SCM_ACTIONS.MultiFileDiff);
                await waitForTab(page, /working copy edits/);
            }).toPass({ timeout: 20000 });
            await waitForVisibleMultiDiff(page);

            await expectMultiDiffEntryStates(page, [
                { modifiedLabel: 'root_notes.md', allowExternalPath: true, isRenamed: false },
                { modifiedLabel: 'cli_util.rs', descriptionContains: 'src', isRenamed: false },
            ]);
        } finally {
            vscode.requestReset();
            await repo.dispose();
        }
    });

    test('Ancestor multi-diff and Compare All Files with Revision distinguish Modified vs Renamed', async ({
        vscode,
    }) => {
        const repo = new TestRepo();
        let changedEditableSetting = false;

        try {
            repo.init();
            const commits = await buildGraph(repo, [
                {
                    label: 'initial',
                    description: 'initial baseline',
                    files: {
                        'cli/src/cli_util.rs': INITIAL_CLI_UTIL,
                        'legacy/old_name.txt': SHARED_RENAME_LINES,
                    },
                },
            ]);
            repo.new([commits.initial.changeId], 'feature refactor');
            repo.writeFile('cli/src/cli_util.rs', MODIFIED_CLI_UTIL);
            repo.writeFile('modern/new_name.txt', `${SHARED_RENAME_LINES}\nexport const extra = "feature";`);
            repo.deleteFile('legacy/old_name.txt');

            repo.new(undefined, 'working copy notes');
            repo.writeFile('extra.txt', 'working copy addition\n');

            const { page } = await vscode.openWorkspace(repo);
            await focusSCM(page);

            // 1. Editable mutable ancestor diff (jj-view -> jj-edit)
            await clickScmAction(page, /feature refactor/, SCM_ACTIONS.MultiFileDiff);
            await waitForTab(page, /feature refactor/);
            await waitForVisibleMultiDiff(page);
            await expectMultiDiffEntryStates(page, [
                { modifiedLabel: 'cli_util.rs', descriptionContains: 'cli/src', isRenamed: false },
                {
                    modifiedLabel: 'new_name.txt',
                    descriptionContains: 'modern',
                    isRenamed: true,
                    originalText: 'old_name.txt',
                },
            ]);

            // 2. Read-only ancestor diff with editableMutableDiffs disabled (jj-view -> jj-view)
            changedEditableSetting = true;
            await vscode.evaluate(async (vs) => {
                await vs.commands.executeCommand('workbench.action.closeAllEditors', { skipConfirm: true });
                await vs.workspace
                    .getConfiguration('jj-view')
                    .update('editableMutableDiffs', false, vs.ConfigurationTarget.Global);
            });
            await expect(page.getByRole('tab', { name: /feature refactor/ })).toHaveCount(0, { timeout: 10000 });

            await clickScmAction(page, /feature refactor/, SCM_ACTIONS.MultiFileDiff);
            await waitForTab(page, /feature refactor/);
            await waitForVisibleMultiDiff(page);
            await expectMultiDiffEntryStates(page, [
                { modifiedLabel: 'cli_util.rs', descriptionContains: 'cli/src', isRenamed: false },
                {
                    modifiedLabel: 'new_name.txt',
                    descriptionContains: 'modern',
                    isRenamed: true,
                    originalText: 'old_name.txt',
                },
            ]);

            // 3. Compare All Files with Revision... (jj-view -> file://)
            await vscode.evaluate(async (vs) => {
                await vs.commands.executeCommand('workbench.action.closeAllEditors', { skipConfirm: true });
            });
            await focusJJLog(page);
            const initialRow = await waitForLogCommitRow(page, { changeId: commits.initial.changeId }, repo);
            await rightClickAndSelect(page, initialRow, 'Compare All Files with Revision...');
            await waitForTab(page, /Compare .* with Working Copy/);
            await waitForVisibleMultiDiff(page);
            await expectMultiDiffEntryStates(page, [
                { modifiedLabel: 'cli_util.rs', descriptionContains: 'cli/src', isRenamed: false },
                {
                    modifiedLabel: 'new_name.txt',
                    descriptionContains: 'modern',
                    isRenamed: true,
                    originalText: 'old_name.txt',
                },
            ]);
        } finally {
            if (changedEditableSetting) {
                await vscode
                    .evaluate(async (vs) => {
                        await vs.workspace
                            .getConfiguration('jj-view')
                            .update('editableMutableDiffs', true, vs.ConfigurationTarget.Global);
                    })
                    .catch(() => {});
            }
            vscode.requestReset();
            await repo.dispose();
        }
    });
});
