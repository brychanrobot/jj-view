/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Uri } from '../../core/uri-utils';
import { expect, test, waitForScmReady } from './standalone-fixture';

interface PierreHeaderInfo {
    changeType: string;
    prevName: string;
    headerText: string;
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

const PURE_RENAME_LINES = [
    'export const pureModule = "immutable-copy";',
    'export const p1 = "one";',
    'export const p2 = "two";',
    'export const p3 = "three";',
    'export const p4 = "four";',
    'export const p5 = "five";',
    'export const p6 = "six";',
    'export const p7 = "seven";',
    'export const p8 = "eight";',
    'export const p9 = "nine";',
].join('\n');

test.describe('Standalone Multi-Diff Modified vs Renamed (#655)', () => {
    test('Working copy multi-diff shows modified files as Modified and genuine renames as Renamed', async ({
        page,
        server,
        testRepo,
    }) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => {
            const isExpectedSidecarError =
                err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
            if (!isExpectedSidecarError) {
                pageErrors.push(err.message);
            }
        });

        testRepo.writeFile('cli/src/cli_util.rs', 'pub fn util() { println!("v1"); }\n');
        testRepo.writeFile('legacy/old_name.txt', SHARED_RENAME_LINES);
        testRepo.writeFile('legacy/pure_old.txt', PURE_RENAME_LINES);
        testRepo.describe('initial baseline');
        testRepo.new();

        testRepo.writeFile('cli/src/cli_util.rs', 'pub fn util() { println!("v2"); }\n');
        testRepo.writeFile('modern/new_name.txt', `${SHARED_RENAME_LINES}\nexport const extra = "updated";`);
        testRepo.deleteFile('legacy/old_name.txt');
        testRepo.writeFile('modern/pure_new.txt', PURE_RENAME_LINES);
        testRepo.deleteFile('legacy/pure_old.txt');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await expect(
            page.locator('[data-testid="scm-group-working-copy"] [data-testid="scm-resource-item"]', {
                hasText: 'cli_util.rs',
            }),
        ).toBeVisible({ timeout: 15000 });

        const workingCopyHeader = page.locator('[data-testid="scm-group-header-working-copy"]');
        await workingCopyHeader.hover();
        const multiDiffBtn = workingCopyHeader.locator('[data-testid="scm-group-action-jj-view.showMultiFileDiff"]');
        await expect(multiDiffBtn).toBeVisible({ timeout: 5000 });
        await multiDiffBtn.click();

        const multiDiffViewer = page.locator('[data-testid="pierre-multi-diff-viewer"]');
        await expect(multiDiffViewer).toBeVisible({ timeout: 15000 });

        await expect
            .poll(
                async (): Promise<PierreHeaderInfo[]> => {
                    return await page.evaluate(() => {
                        const containers = Array.from(
                            document.querySelectorAll('[data-testid="pierre-multi-diff-viewer"] diffs-container'),
                        );
                        return containers.map((container) => {
                            const header = container.shadowRoot?.querySelector('[data-diffs-header]');
                            const changeType = header?.getAttribute('data-change-type') ?? '';
                            const prevName = header?.querySelector('[data-prev-name]')?.textContent?.trim() ?? '';
                            const headerText = header?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
                            return { changeType, prevName, headerText };
                        });
                    });
                },
                {
                    timeout: 15000,
                    message:
                        'Expected PierreMultiDiffViewer headers for modified, rename-changed, and rename-pure files',
                },
            )
            .toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        changeType: 'change',
                        prevName: '',
                        headerText: expect.stringContaining('cli/src/cli_util.rs'),
                    }),
                    expect.objectContaining({
                        changeType: 'rename-changed',
                        prevName: 'legacy/old_name.txt',
                        headerText: expect.stringContaining('modern/new_name.txt'),
                    }),
                    expect.objectContaining({
                        changeType: 'rename-pure',
                        prevName: 'legacy/pure_old.txt',
                        headerText: expect.stringContaining('modern/pure_new.txt'),
                    }),
                ]),
            );

        expect(pageErrors).toEqual([]);
    });

    test('Preserves prevName and file name when renamed files transition to or from empty content', async ({
        page,
        server,
        testRepo,
    }) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => {
            const isExpectedSidecarError =
                err.message.includes('agentapi failed') || err.message.includes('agentapi binary not found');
            if (!isExpectedSidecarError) {
                pageErrors.push(err.message);
            }
        });

        testRepo.writeFile('legacy/empty_orig.txt', '');
        testRepo.writeFile('legacy/nonempty_orig.txt', 'before\n');
        testRepo.writeFile('mod_to_empty.txt', 'before\n');
        testRepo.describe('base');
        testRepo.new(undefined, 'curr');
        testRepo.writeFile('modern/from_empty.txt', 'populated\n');
        testRepo.writeFile('modern/to_empty.txt', '');
        testRepo.deleteFile('legacy/empty_orig.txt');
        testRepo.deleteFile('legacy/nonempty_orig.txt');
        testRepo.writeFile('mod_to_empty.txt', '');

        await page.goto(server.serverUrl);
        await waitForScmReady(page);

        await page.evaluate(async (repoRoot) => {
            const env = window.__JJ_VIEW_ENV__;
            if (!env) {
                throw new Error('Standalone host env unavailable');
            }
            const makeUri = (relPath: string, rev: string): Uri => {
                const fullPath = `${repoRoot}/${relPath}`.replace(/\/+/g, '/');
                const fragment = `mode=revision&root=${encodeURIComponent(repoRoot)}&revision=${encodeURIComponent(rev)}`;
                const build = (overridePath = fullPath, overrideFragment = fragment): Uri => {
                    const uri: Uri = {
                        scheme: 'jj-view',
                        authority: '',
                        path: overridePath,
                        query: '',
                        fragment: overrideFragment,
                        fsPath: overridePath,
                        toString: () => `jj-view://${overridePath}#${overrideFragment}`,
                        toJSON: () => ({
                            scheme: 'jj-view',
                            authority: '',
                            path: overridePath,
                            query: '',
                            fragment: overrideFragment,
                        }),
                        with: (change) => build(change.path ?? overridePath, change.fragment ?? overrideFragment),
                    };
                    return uri;
                };
                return build();
            };
            await env.nav.openMultiDiff('Empty Rename Edge Cases', [
                {
                    label: 'modern/from_empty.txt',
                    oldLabel: 'legacy/empty_orig.txt',
                    status: 'renamed',
                    leftUri: makeUri('legacy/empty_orig.txt', '@-'),
                    rightUri: makeUri('modern/from_empty.txt', '@'),
                },
                {
                    label: 'modern/to_empty.txt',
                    oldLabel: 'legacy/nonempty_orig.txt',
                    status: 'renamed',
                    leftUri: makeUri('legacy/nonempty_orig.txt', '@-'),
                    rightUri: makeUri('modern/to_empty.txt', '@'),
                },
                {
                    label: 'mod_to_empty.txt',
                    status: 'modified',
                    leftUri: makeUri('mod_to_empty.txt', '@-'),
                    rightUri: makeUri('mod_to_empty.txt', '@'),
                },
            ]);
        }, testRepo.path);

        const multiDiffViewer = page.locator('[data-testid="pierre-multi-diff-viewer"]');
        await expect(multiDiffViewer).toBeVisible({ timeout: 15000 });

        await expect
            .poll(
                async (): Promise<PierreHeaderInfo[]> => {
                    return await page.evaluate(() => {
                        const containers = Array.from(
                            document.querySelectorAll('[data-testid="pierre-multi-diff-viewer"] diffs-container'),
                        );
                        return containers.map((container) => {
                            const header = container.shadowRoot?.querySelector('[data-diffs-header]');
                            const changeType = header?.getAttribute('data-change-type') ?? '';
                            const prevName = header?.querySelector('[data-prev-name]')?.textContent?.trim() ?? '';
                            const headerText = header?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
                            return { changeType, prevName, headerText };
                        });
                    });
                },
                {
                    timeout: 15000,
                    message: 'Expected empty<->nonempty renamed and modified files to keep accurate headers',
                },
            )
            .toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        changeType: 'rename-changed',
                        prevName: 'legacy/empty_orig.txt',
                        headerText: expect.stringContaining('modern/from_empty.txt'),
                    }),
                    expect.objectContaining({
                        changeType: 'rename-changed',
                        prevName: 'legacy/nonempty_orig.txt',
                        headerText: expect.stringContaining('modern/to_empty.txt'),
                    }),
                    expect.objectContaining({
                        changeType: 'change',
                        prevName: '',
                        headerText: expect.stringContaining('mod_to_empty.txt'),
                    }),
                ]),
            );

        expect(pageErrors).toEqual([]);
    });
});
