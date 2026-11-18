/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, type Frame, type Locator, type Page } from '@playwright/test';
import { getPersonDisplayStrings } from '../../core/webview/common/utils/person-utils';
import { toUnicodeSansBold, toUnicodeSansRegular } from '../../core/webview/log/utils/commit-tooltip';
import { buildGraph, ROOT_ID, TestRepo } from '../test-repo';
import {
    clickLogAction,
    dragAndDrop,
    ensureViewVisible,
    focusJJLog,
    getLogWebview,
    pickQuickPickItem,
    test,
    triggerRefresh,
    waitForLogCommitRow,
    waitForLogPill,
    waitForTree,
    waitForWebviewCommitRemoved,
    waitForWebviewWorkingCopy,
} from './e2e-helpers';
import type { VSCodeFixture } from './vscode-fixture';

interface LogScrollTelemetry {
    readonly docClientH: number;
    readonly docScrollH: number;
    readonly docScrollTop: number;
    readonly bodyClientH: number;
    readonly bodyScrollH: number;
    readonly bodyScrollTop: number;
    readonly rootClientH: number;
    readonly rootScrollH: number;
    readonly appClientH: number;
    readonly appScrollH: number;
    readonly scClientH: number;
    readonly scScrollH: number;
    readonly scScrollTop: number;
    readonly scClientW: number;
    readonly scScrollW: number;
    readonly verticalScrollables: readonly string[];
}

async function getLogScrollTelemetry(webview: Frame): Promise<LogScrollTelemetry> {
    return await webview.evaluate(() => {
        const sc = document.querySelector('.scroll-container');
        const app = document.querySelector('.app-container');
        const root = document.getElementById('root');
        const docEl = document.documentElement;
        const body = document.body;
        const scrollingEl = document.scrollingElement;

        const verticalScrollables: string[] = [];
        for (const el of Array.from(document.querySelectorAll('*'))) {
            const style = getComputedStyle(el);
            const isScrollableY = style.overflowY === 'auto' || style.overflowY === 'scroll';
            if (isScrollableY && el.scrollHeight > el.clientHeight + 1) {
                const classPart =
                    typeof el.className === 'string' && el.className.trim()
                        ? `.${el.className.trim().split(/\s+/).join('.')}`
                        : '';
                verticalScrollables.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classPart}`);
            }
        }

        return {
            docClientH: docEl.clientHeight,
            docScrollH: docEl.scrollHeight,
            docScrollTop: scrollingEl?.scrollTop ?? docEl.scrollTop,
            bodyClientH: body.clientHeight,
            bodyScrollH: body.scrollHeight,
            bodyScrollTop: body.scrollTop,
            rootClientH: root?.clientHeight ?? 0,
            rootScrollH: root?.scrollHeight ?? 0,
            appClientH: app?.clientHeight ?? 0,
            appScrollH: app?.scrollHeight ?? 0,
            scClientH: sc?.clientHeight ?? 0,
            scScrollH: sc?.scrollHeight ?? 0,
            scScrollTop: sc?.scrollTop ?? 0,
            scClientW: sc?.clientWidth ?? 0,
            scScrollW: sc?.scrollWidth ?? 0,
            verticalScrollables,
        };
    });
}

function expectNoOuterVerticalOverflow(t: LogScrollTelemetry): void {
    expect(t.docScrollH).toBeLessThanOrEqual(t.docClientH);
    expect(t.bodyScrollH).toBeLessThanOrEqual(t.bodyClientH);
    expect(t.rootScrollH).toBeLessThanOrEqual(t.rootClientH);
    expect(t.appScrollH).toBeLessThanOrEqual(t.appClientH);
}

function expectSingleVerticalLogScrollbar(t: LogScrollTelemetry): void {
    expectNoOuterVerticalOverflow(t);
    expect(t.scScrollH).toBeGreaterThan(t.scClientH);
    expect(t.scScrollW).toBeLessThanOrEqual(t.scClientW);
    expect(t.verticalScrollables).toHaveLength(1);
    expect(t.verticalScrollables[0]).toContain('scroll-container');
}

async function openLogPaneWithCollapsedChanges(
    page: Page,
    height: number,
): Promise<{ webview: Frame; changesHeader: Locator; collapsedChanges: boolean }> {
    const logHeader = page.locator('.pane-header', { hasText: 'JJ Log' }).first();
    await ensureViewVisible(page, logHeader, 'Control+Alt+l');
    if ((await logHeader.getAttribute('aria-expanded')) === 'false') {
        await logHeader.click();
    }
    const changesHeader = page.locator('.pane-header', { hasText: 'Changes' }).first();
    await expect(changesHeader).toBeVisible({ timeout: 10000 });
    let collapsedChanges = false;
    if ((await changesHeader.getAttribute('aria-expanded')) === 'true') {
        await changesHeader.click();
        await expect(changesHeader).toHaveAttribute('aria-expanded', 'false');
        collapsedChanges = true;
    }
    await page.keyboard.press('Control+Alt+l');
    await page.setViewportSize({ width: 1280, height });

    const webview = await getLogWebview(page);
    await expect(webview.locator('.commit-row').first()).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await getLogScrollTelemetry(webview)).scClientH).toBeGreaterThan(280);
    return { webview, changesHeader, collapsedChanges };
}

interface ScrollTestCleanupState {
    readonly activePage?: Page;
    readonly originalViewport: { width: number; height: number } | null;
    readonly changesHeader?: Locator;
    readonly collapsedChanges: boolean;
    readonly originalColorTheme?: string;
    readonly changedTheme: boolean;
}

async function restoreScrollTestState(
    vscode: VSCodeFixture,
    repo: TestRepo,
    state: ScrollTestCleanupState,
): Promise<void> {
    if (state.changedTheme) {
        await vscode
            .evaluate(async (vscodeApi, _api, targetTheme) => {
                if (typeof targetTheme !== 'string') {
                    return;
                }
                await vscodeApi.workspace
                    .getConfiguration('workbench')
                    .update('colorTheme', targetTheme, vscodeApi.ConfigurationTarget.Global);
            }, state.originalColorTheme ?? 'Default Dark Modern')
            .catch(() => {});
        if (state.activePage) {
            await expect(state.activePage.locator('.monaco-workbench'))
                .not.toHaveClass(/(?:^|\s)vs(?:\s|$)/, { timeout: 5000 })
                .catch(() => {});
        }
    }
    if (state.collapsedChanges && state.changesHeader) {
        const isExpanded = await state.changesHeader.getAttribute('aria-expanded').catch(() => null);
        if (isExpanded === 'false') {
            await state.changesHeader.click().catch(() => {});
            await expect(state.changesHeader)
                .toHaveAttribute('aria-expanded', 'true', { timeout: 5000 })
                .catch(() => {});
        }
    }
    if (state.activePage && state.originalViewport) {
        await state.activePage.setViewportSize(state.originalViewport).catch(() => {});
    }
    if (state.activePage) {
        await vscode.clearRepositoryManager().catch(() => {});
    }
    await repo.dispose();
}

test.describe('JJ Log Pane E2E', () => {
    test('Webview Initialization & Rendering', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'side_branch',
                parents: ['initial'],
                description: 'side branch commit',
                files: { 'file2.txt': 'base2' },
            },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
                bookmarks: ['main'],
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);
        const webview = await getLogWebview(page);

        // Assert all commit descriptions are present
        await expect(await waitForLogCommitRow(page, 'initial setup')).toBeVisible();
        await expect(await waitForLogCommitRow(page, 'side branch commit')).toBeVisible();
        await expect(await waitForLogCommitRow(page, 'working tree')).toBeVisible();

        // Assert Working Copy row is styled bold
        const wcDesc = webview.locator('.working-copy .commit-desc');
        await expect(wcDesc).toHaveCSS('font-weight', '700' /* bold */);

        // Assert Bookmark pill is present inside the working copy row
        await waitForLogPill(page, 'main', 'bookmark');
    });

    test('Pane Header Actions: Undo and New Merge Change', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            { label: 'side_branch', parents: ['initial'], description: 'side branch', files: { 'file2.txt': 'base2' } },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);
        // 1. New Merge Change (Requires Multi-select)
        const sideBranchRow = await waitForLogCommitRow(page, { changeId: nodes.side_branch.changeId });
        const wcRow = await waitForLogCommitRow(page, { changeId: nodes.wc.changeId });

        // Click the first one normally, the second with Control
        await sideBranchRow.click();
        await expect(sideBranchRow).toHaveAttribute('data-selected', 'true');

        await wcRow.click({ modifiers: ['Control'] });
        await expect(wcRow).toHaveAttribute('data-selected', 'true');

        // Click the native 'New Merge Change' header action
        // name-based locator is more robust for VS Code header actions
        const mergeAction = page.getByRole('button', { name: 'New Merge Change' }).first();
        await expect(mergeAction).toBeEnabled();
        await mergeAction.click();

        // Assert via repo that a new merge commit was created with correct parents
        await expect(async () => {
            const parents = repo.getParents('@');
            expect(parents).toContain(nodes.side_branch.changeId);
            expect(parents).toContain(nodes.wc.changeId);
        }).toPass({ timeout: 5000 });

        // Verify full tree: [merge, wc, side_branch, initial, dummy]
        const mergeChangeId = repo.getChangeId('@');
        await waitForTree(repo, [
            {
                isWorkingCopy: true,
                changeId: mergeChangeId,
                description: '(empty)',
                parents: [nodes.side_branch.changeId, nodes.wc.changeId],
            },
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.initial.changeId },
            { changeId: nodes.side_branch.changeId, description: 'side branch', parents: nodes.initial.changeId },
            { changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);

        // 2. Undo
        const undoAction = page.getByRole('button', { name: 'Undo' }).first();
        await undoAction.click();

        // Assert the merge change was undone accurately
        await waitForTree(repo, [
            {
                isWorkingCopy: true,
                changeId: nodes.wc.changeId,
                description: 'working tree',
                parents: nodes.initial.changeId,
            },
            { changeId: nodes.side_branch.changeId, description: 'side branch', parents: nodes.initial.changeId },
            { changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Hover Actions: New Child, Squash, Abandon', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            { label: 'branch', parents: ['initial'], description: 'branch commit', files: { 'file2.txt': 'base2' } },
            {
                label: 'wc',
                parents: ['branch'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);

        // 1. New Child
        const branchId = nodes.branch.changeId;
        await clickLogAction(page, { changeId: branchId }, 'New Child');

        let childId = '';
        await expect(async () => {
            const currentId = repo.getChangeId('@');
            // Ensure @ has actually moved away from wc
            expect(currentId).not.toBe(nodes.wc.changeId);
            childId = currentId;
        }).toPass({ timeout: 10000 });

        // Make a file change in the child so it's not abandoned by 'jj edit'
        // but keep description empty so 'jj squash' stays silent
        repo.writeFile('child.txt', 'child content');

        // Tree: [new_child(@), wc, branch, initial, dummy]
        await waitForTree(repo, [
            { isWorkingCopy: true, changeId: childId, description: '(empty)', parents: nodes.branch.changeId },
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.branch.changeId },
            { changeId: nodes.branch.changeId, description: 'branch commit', parents: nodes.initial.changeId },
            { changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewWorkingCopy(page, childId);

        // 2. Prepare for squash: move working copy away from the new child
        const initialId = nodes.initial.changeId;
        await clickLogAction(page, { changeId: initialId }, 'Edit Commit');

        // Tree is the same commits, just @ moved. Order: [child, wc, branch, initial, dummy]
        await waitForTree(repo, [
            { changeId: childId, description: '(empty)', parents: nodes.branch.changeId },
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.branch.changeId },
            { changeId: nodes.branch.changeId, description: 'branch commit', parents: nodes.initial.changeId },
            { isWorkingCopy: true, changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewWorkingCopy(page, initialId);

        // 3. Squash the child into branch
        await clickLogAction(page, { changeId: childId }, 'Squash');

        // After squash: child is gone. branch has its changes.
        await waitForTree(repo, [
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.branch.changeId },
            { changeId: nodes.branch.changeId, description: 'branch commit', parents: nodes.initial.changeId },
            { isWorkingCopy: true, changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewCommitRemoved(page, childId);

        // 4. Abandon the branch commit
        await clickLogAction(page, { changeId: branchId }, 'Abandon');

        // After abandon branch: branch is gone. wc (child of branch) becomes child of initial.
        // Tree: [wc, initial(@)]
        await waitForTree(repo, [
            { changeId: nodes.wc.changeId, description: 'working tree', parents: nodes.initial.changeId },
            { isWorkingCopy: true, changeId: nodes.initial.changeId, description: 'initial setup', parents: dummyId },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
        await waitForWebviewCommitRemoved(page, branchId);
    });

    test('Multi-select and Drag & Drop (Rebase)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'target',
                parents: ['initial'],
                description: 'target branch',
                files: { 'file_target.txt': 'target' },
            },
            {
                label: 'source',
                parents: ['initial'],
                description: 'source branch',
                files: { 'file_source.txt': 'source' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await sourceRow.scrollIntoViewIfNeeded();
        await targetRow.scrollIntoViewIfNeeded();

        // Drag source onto target to rebase
        await dragAndDrop(page, { source: sourceRow, target: targetRow });

        // Verify rebase via repo
        await expect(async () => {
            // Check 'source' parent is now 'target'
            const parents = repo.getParents(nodes.source.changeId);
            expect(parents).toContain(nodes.target.changeId);
        }).toPass({ timeout: 10000 });
    });

    test('Drag and Drop Commit with a key inserts revision after target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'a', parents: ['root'], description: 'commit A', files: { 'a.txt': 'a' } },
            { label: 'b', parents: ['a'], description: 'commit B', files: { 'b.txt': 'b' } },
            { label: 'c', parents: ['b'], description: 'commit C', files: { 'c.txt': 'c' } },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const rowC = await waitForLogCommitRow(page, { changeId: nodes.c.changeId });
        const rowA = await waitForLogCommitRow(page, { changeId: nodes.a.changeId });
        await rowC.scrollIntoViewIfNeeded();
        await rowA.scrollIntoViewIfNeeded();

        // Drag C onto A with key 'a' to insert after A
        await dragAndDrop(page, { source: rowC, target: rowA, key: 'a' });

        await expect(async () => {
            const parentsC = repo.getParents(nodes.c.changeId);
            const parentsB = repo.getParents(nodes.b.changeId);
            expect(parentsC).toContain(nodes.a.changeId);
            expect(parentsB).toContain(nodes.c.changeId);
        }).toPass({ timeout: 10000 });
    });

    test('Drag and Drop Commit with b key inserts revision before target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'a', parents: ['root'], description: 'commit A', files: { 'a.txt': 'a' } },
            { label: 'b', parents: ['a'], description: 'commit B', files: { 'b.txt': 'b' } },
            { label: 'c', parents: ['b'], description: 'commit C', files: { 'c.txt': 'c' } },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const rowC = await waitForLogCommitRow(page, { changeId: nodes.c.changeId });
        const rowB = await waitForLogCommitRow(page, { changeId: nodes.b.changeId });
        await rowC.scrollIntoViewIfNeeded();
        await rowB.scrollIntoViewIfNeeded();

        // Drag C onto B with key 'b' to insert before B
        await dragAndDrop(page, { source: rowC, target: rowB, key: 'b' });

        await expect(async () => {
            const parentsC = repo.getParents(nodes.c.changeId);
            const parentsB = repo.getParents(nodes.b.changeId);
            expect(parentsC).toContain(nodes.a.changeId);
            expect(parentsB).toContain(nodes.c.changeId);
        }).toPass({ timeout: 10000 });
    });

    test('Drag and Drop Commit with s key squashes source into target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'target', description: 'target commit', files: { 'target.txt': 'base' } },
            {
                label: 'source',
                parents: ['target'],
                description: 'source commit',
                files: { 'source.txt': 'mod' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await dragAndDrop(page, { source: sourceRow, target: targetRow, key: 's' });

        await waitForTree(repo, [
            { isWorkingCopy: true, changeId: '*', description: '(empty)', parents: nodes.target.changeId },
            {
                changeId: nodes.target.changeId,
                description: 'target commit',
                parents: dummyId,
                files: { 'target.txt': 'base', 'source.txt': 'mod' },
            },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Drag and Drop Commit with Shift+s key squashes source onto target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'target', description: 'target commit', files: { 'target.txt': 'base' } },
            {
                label: 'source',
                parents: ['root()'],
                description: 'source commit',
                files: { 'source.txt': 'mod' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await dragAndDrop(page, { source: sourceRow, target: targetRow, key: 'Shift+s' });

        await waitForTree(repo, [
            { isWorkingCopy: true, changeId: '*', description: '(empty)', parents: ROOT_ID },
            {
                changeId: '*',
                description: 'source commit',
                parents: nodes.target.changeId,
                files: { 'source.txt': 'mod' },
            },
            {
                changeId: nodes.target.changeId,
                description: 'target commit',
                parents: dummyId,
                files: { 'target.txt': 'base' },
            },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Drag and Drop Commit with d key duplicates source onto target', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const dummyId = repo.getChangeId('@');
        const nodes = await buildGraph(repo, [
            { label: 'target', description: 'target commit', files: { 'target.txt': 'base' } },
            {
                label: 'source',
                parents: ['root()'],
                description: 'source to duplicate',
                files: { 'source.txt': 'mod' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const sourceRow = await waitForLogCommitRow(page, { changeId: nodes.source.changeId });
        const targetRow = await waitForLogCommitRow(page, { changeId: nodes.target.changeId });

        await dragAndDrop(page, { source: sourceRow, target: targetRow, key: 'd' });

        await waitForTree(repo, [
            {
                changeId: '*',
                description: 'source to duplicate',
                parents: nodes.target.changeId,
                files: { 'source.txt': 'mod' },
            },
            {
                isWorkingCopy: true,
                changeId: nodes.source.changeId,
                description: 'source to duplicate',
                parents: ROOT_ID,
                files: { 'source.txt': 'mod' },
            },
            {
                changeId: nodes.target.changeId,
                description: 'target commit',
                parents: dummyId,
                files: { 'target.txt': 'base' },
            },
            { changeId: dummyId, description: '(empty)', parents: ROOT_ID },
        ]);
    });

    test('Delete Bookmark (Command Palette/Quick Pick Flow)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 1. Create a local bookmark via CLI
        repo.bookmark('local-to-delete', nodes.wc.changeId);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);
        await triggerRefresh(page);

        // 2. Verify bookmark pill is visible
        const bookmarkPill = await waitForLogPill(page, 'local-to-delete', 'bookmark');
        await expect(bookmarkPill).toBeVisible();

        // 3. Trigger Delete Bookmark via keyboard shortcut
        await page.keyboard.press('Control+Alt+D');

        // 4. Select the bookmark to delete in the Quick Pick
        await pickQuickPickItem(page, 'local-to-delete');

        // 5. Verify the bookmark pill disappears from the webview
        await expect(bookmarkPill).toBeHidden({ timeout: 10000 });
    });

    test('Drag & Drop Bookmark (Advance/Move)', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'wc',
                parents: ['initial'],
                description: 'working tree',
                files: { 'file.txt': 'mod' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 1. Create a bookmark on initial commit
        repo.bookmark('drag-bookmark', nodes.initial.changeId);

        const { page } = await vscode.openWorkspace(repo);

        await focusJJLog(page);

        // 2. Locate the draggable bookmark pill and target commit row (move forward)
        const bookmarkPill = await waitForLogPill(page, 'drag-bookmark', 'bookmark');
        const wcRow = await waitForLogCommitRow(page, { changeId: nodes.wc.changeId });

        // 3. Drag the bookmark pill onto the wc commit row (move forward)
        await dragAndDrop(page, { source: bookmarkPill, target: wcRow });

        // 4. Verify bookmark moved to wc in local repository
        const wcCommitId = repo.getCommitId(nodes.wc.changeId);
        await expect(async () => {
            expect(repo.getCommitId('drag-bookmark')).toBe(wcCommitId);
        }).toPass({ timeout: 10000 });

        // 5. Drag it backward (from wc back onto initial commit)
        const initialRow = await waitForLogCommitRow(page, { changeId: nodes.initial.changeId });
        // Re-fetch the bookmark pill since the webview refreshes after the move command
        const bookmarkPillAfterMove = await waitForLogPill(page, 'drag-bookmark', 'bookmark');
        await dragAndDrop(page, { source: bookmarkPillAfterMove, target: initialRow });

        // 6. Verify bookmark moved back to initial commit in local repository
        const initialCommitId = repo.getCommitId(nodes.initial.changeId);
        await expect(async () => {
            expect(repo.getCommitId('drag-bookmark')).toBe(initialCommitId);
        }).toPass({ timeout: 10000 });
    });

    test('Escape key clears commit selection', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            { label: 'feature', parents: ['initial'], description: 'feature commit', files: { 'file2.txt': 'mod' } },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);
        const webview = await getLogWebview(page);

        const featureRow = await waitForLogCommitRow(page, { changeId: nodes.feature.changeId });
        await featureRow.click();
        await expect(featureRow).toHaveAttribute('data-selected', 'true');

        // Press Escape inside the webview
        await webview.locator('body').press('Escape');

        // Verify selection is cleared
        await expect(featureRow).toHaveAttribute('data-selected', 'false');
    });

    test('Commit description title tooltip displays relative timestamps and details', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial setup', files: { 'file.txt': 'base' } },
            {
                label: 'feature',
                parents: ['initial'],
                description: 'feature commit\n\nExtended details about the feature.',
                files: { 'file2.txt': 'mod' },
            },
        ]);

        const { page } = await vscode.openWorkspace(repo);
        await focusJJLog(page);

        const featureRow = await waitForLogCommitRow(page, { changeId: nodes.feature.changeId });
        const featureDesc = featureRow.locator('.commit-desc');

        // Verify the title tooltip format. Use a regex pattern for relative time to prevent
        // race conditions where the webview and test runner evaluate Date.now() on different
        // second boundaries (e.g. "just now" vs "1 second ago").
        const shortest = repo.getLog(nodes.feature.commitId, 'change_id.shortest()');
        const timestamp = repo.getLog(nodes.feature.commitId, 'author.timestamp()');
        const { fullTime } = getPersonDisplayStrings({ name: '', email: '', timestamp });
        const truncatedChangeId = nodes.feature.changeId.slice(0, 10);
        const boldShortest = toUnicodeSansBold(shortest);
        const restChangeId = toUnicodeSansRegular(truncatedChangeId.slice(shortest.length));
        const sansRegularCommitId = toUnicodeSansRegular(nodes.feature.commitId.slice(0, 10));

        const escapedFullTime = fullTime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const expectedPattern = new RegExp(
            `^` +
                [
                    `ᴄʜᴀɴɢᴇ: ${boldShortest}${restChangeId}`,
                    `ᴄᴏᴍᴍɪᴛ: ${sansRegularCommitId}`,
                    `ᴅᴀᴛᴇ: (?:just now|\\d+ (?:second|minute|hour|day|week|month|year)s? ago) \\(${escapedFullTime}\\)`,
                    '────────────────',
                    'feature commit',
                    '',
                    'Extended details about the feature\\.',
                ].join('\\n') +
                `$`,
        );

        await expect(featureDesc).toHaveAttribute('title', expectedPattern);
    });

    test('Log view renders strictly one vertical scrollable container for long history (#397)', async ({ vscode }) => {
        const repo = new TestRepo();
        let activePage: Page | undefined;
        let originalViewport: { width: number; height: number } | null = null;
        let changesHeader: Locator | undefined;
        let collapsedChanges = false;
        let originalColorTheme: string | undefined;
        let changedTheme = false;

        try {
            repo.init();
            await buildGraph(repo, [
                { label: 'b0', description: 'base commit', files: { 'f.txt': '0' } },
                { label: 'b1', parents: ['b0'], description: 'branch 1 commit', files: { 'f1.txt': '1' } },
                { label: 'b2', parents: ['b0'], description: 'branch 2 commit', files: { 'f2.txt': '2' } },
                {
                    label: 'merge',
                    parents: ['b1', 'b2'],
                    description: 'merge branch 1 and branch 2',
                    files: { 'merge.txt': 'm' },
                },
            ]);
            for (let i = 1; i <= 45; i++) {
                repo.writeFile('history.txt', `revision ${i}\n`);
                repo.describe(`feat: log scrollbar commit ${i}`);
                if (i < 45) {
                    repo.new();
                }
            }

            const { page } = await vscode.openWorkspace(repo);
            activePage = page;
            originalViewport =
                page.viewportSize() ??
                (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
            const rawTheme = await vscode.evaluate((vscodeApi) =>
                vscodeApi.workspace.getConfiguration('workbench').get<string>('colorTheme'),
            );
            originalColorTheme = typeof rawTheme === 'string' && rawTheme.length > 0 ? rawTheme : 'Default Dark Modern';

            const opened = await openLogPaneWithCollapsedChanges(page, 500);
            const webview = opened.webview;
            changesHeader = opened.changesHeader;
            collapsedChanges = opened.collapsedChanges;

            const initialTelemetry = await getLogScrollTelemetry(webview);
            expectSingleVerticalLogScrollbar(initialTelemetry);

            // Scroll via mouse wheel and verify strictly .scroll-container scrolls to bottom without outer scroll
            const scrollContainer = webview.locator('.scroll-container');
            await scrollContainer.hover();
            await expect
                .poll(async () => {
                    await page.mouse.wheel(0, 400);
                    return (await getLogScrollTelemetry(webview)).scScrollTop;
                })
                .toBeGreaterThan(0);

            const bottomRow = webview.locator('.commit-row', { hasText: 'base commit' });
            await bottomRow.scrollIntoViewIfNeeded();
            await expect(bottomRow).toBeVisible();

            const scrolledTelemetry = await getLogScrollTelemetry(webview);
            expect(scrolledTelemetry.docScrollTop).toBe(0);
            expect(scrolledTelemetry.bodyScrollTop).toBe(0);
            expect(scrolledTelemetry.scScrollTop).toBeGreaterThan(0);
            expectSingleVerticalLogScrollbar(scrolledTelemetry);

            // Resize viewport height and verify clientHeight adapts cleanly with strictly one scrollable container
            await page.setViewportSize({ width: 1280, height: 380 });
            await expect
                .poll(async () => (await getLogScrollTelemetry(webview)).scClientH)
                .toBeLessThan(initialTelemetry.scClientH);
            const resizedTelemetry = await getLogScrollTelemetry(webview);
            expectSingleVerticalLogScrollbar(resizedTelemetry);

            // Verify single-scrollbar invariant in Default Light Modern theme as well
            await page.setViewportSize({ width: 1280, height: 500 });
            await expect.poll(async () => (await getLogScrollTelemetry(webview)).scClientH).toBeGreaterThan(280);
            const darkWebviewBg = await webview.evaluate(() => getComputedStyle(document.body).backgroundColor);
            changedTheme = true;
            await vscode.evaluate(async (vscodeApi) => {
                await vscodeApi.workspace
                    .getConfiguration('workbench')
                    .update('colorTheme', 'Default Light Modern', vscodeApi.ConfigurationTarget.Global);
            });
            await expect(page.locator('.monaco-workbench')).toHaveClass(/(?:^|\s)vs(?:\s|$)/, { timeout: 10000 });
            await expect
                .poll(async () => await webview.evaluate(() => getComputedStyle(document.body).backgroundColor))
                .not.toBe(darkWebviewBg);

            const lightTelemetry = await getLogScrollTelemetry(webview);
            expectSingleVerticalLogScrollbar(lightTelemetry);
        } finally {
            await restoreScrollTestState(vscode, repo, {
                activePage,
                originalViewport,
                changesHeader,
                collapsedChanges,
                originalColorTheme,
                changedTheme,
            });
        }
    });

    test('Log view renders zero vertical scrollables for short history (#397)', async ({ vscode }) => {
        const repo = new TestRepo();
        let activePage: Page | undefined;
        let originalViewport: { width: number; height: number } | null = null;
        let changesHeader: Locator | undefined;
        let collapsedChanges = false;

        try {
            repo.init();
            repo.writeFile('a.txt', 'hello\n');
            repo.describe('feat: short history base');
            repo.new();
            repo.writeFile('b.txt', 'world\n');
            repo.describe('feat: short history top');

            const { page } = await vscode.openWorkspace(repo);
            activePage = page;
            originalViewport =
                page.viewportSize() ??
                (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));

            const opened = await openLogPaneWithCollapsedChanges(page, 500);
            const webview = opened.webview;
            changesHeader = opened.changesHeader;
            collapsedChanges = opened.collapsedChanges;

            const telemetry = await getLogScrollTelemetry(webview);
            expectNoOuterVerticalOverflow(telemetry);
            expect(telemetry.scScrollH).toBeLessThanOrEqual(telemetry.scClientH);
            expect(telemetry.scScrollW).toBeLessThanOrEqual(telemetry.scClientW);
            expect(telemetry.verticalScrollables).toHaveLength(0);
        } finally {
            await restoreScrollTestState(vscode, repo, {
                activePage,
                originalViewport,
                changesHeader,
                collapsedChanges,
                changedTheme: false,
            });
        }
    });
});
