/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Locator } from '@playwright/test';
import type { Frame, Page } from 'playwright';
import type { TestRepo } from '../test-repo';
import { logPerf } from './perf-logger';
import {
    type VSCodeContext as FixtureVSCodeContext,
    type VSCodeFixture as FixtureVSCodeFixture,
    isMac as fixtureIsMac,
    ROOT_ID as fixtureRootId,
    test as fixtureTest,
    launchNewVSCode,
} from './vscode-fixture';

export const test = fixtureTest;
export const ROOT_ID = fixtureRootId;
export const isMac = fixtureIsMac;
export type VSCodeContext = FixtureVSCodeContext;
export type VSCodeFixture = FixtureVSCodeFixture;
export const launchVSCode = launchNewVSCode;

/**
 * Presses the keyboard shortcut to focus the SCM view / SCM description input.
 */
export async function pressScmShortcut(page: Page) {
    const start = Date.now();
    await page.keyboard.press(isMac ? 'Meta+Shift+G' : 'Control+Shift+G');
    logPerf('pressScmShortcut', start);
}

/**
 * Robustly ensures a specific VS Code view pane/sidebar is visible using its keyboard shortcut.
 * Resolves window/iframe focus issues before pressing the keys.
 */
export async function ensureViewVisible(
    page: Page,
    paneLocator: Locator,
    shortcut: string,
    timeout = 20000,
): Promise<void> {
    const start = Date.now();
    if (await paneLocator.isVisible()) {
        return;
    }
    await expect(async () => {
        // Clear focus from any active iframe/webview to allow top-level keybinding to work.
        // Blurring activeElement directly doesn't work if focus is trapped inside a webview iframe
        // within VS Code's shadow DOM. Focusing a top-level tab steals focus back to the main window.
        await page
            .getByRole('tab', { name: /Explorer/i })
            .first()
            .focus()
            .catch(() => {});

        await page.keyboard.press(shortcut);
        await expect(paneLocator).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout });
    logPerf(`ensureViewVisible ${shortcut}`, start);
}

/**
 * Dynamically widens the primary sidebar until it is at least 500px wide.
 * Uses expect().toPass() to wait dynamically for layout updates.
 */
export async function ensureSidebarWide(page: Page) {
    try {
        const sidebar = page.locator('.part.sidebar').first();
        const sidebarBox = await sidebar.boundingBox();
        if (sidebarBox && sidebarBox.width >= 500) {
            return;
        }

        const sashes = page.locator('.monaco-sash.vertical');
        const count = await sashes.count();
        let targetSash: Locator | undefined;
        let sashBox: { x: number; y: number; width: number; height: number } | null = null;

        for (let i = 0; i < count; i++) {
            const s = sashes.nth(i);
            const box = await s.boundingBox();
            if (box && box.x > 100 && box.x < 500) {
                targetSash = s;
                sashBox = box;
                break;
            }
        }

        if (targetSash && sashBox) {
            const startX = sashBox.x + sashBox.width / 2;
            const startY = sashBox.y + sashBox.height / 2;
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(550, startY, { steps: 1 });
            await page.mouse.up();

            // Wait for the layout to update and sidebar to be >= 500
            await expect(async () => {
                const currentBox = await sidebar.boundingBox();
                expect(currentBox).not.toBeNull();
                expect(currentBox?.width).toBeGreaterThanOrEqual(500);
            }).toPass({ timeout: 2000, intervals: [10, 20] });
        }
    } catch (_) {}
}

/**
 * Ensures the SCM view is open and focused.
 */
export async function focusSCM(page: Page) {
    const start = Date.now();
    const scmTitle = page.locator('.pane-header', { hasText: 'Source Control' }).first();
    const scmInput = page.getByRole('treeitem', { name: 'Source Control Input' }).first();

    await ensureViewVisible(page, scmTitle.or(scmInput), isMac ? 'Meta+Shift+G' : 'Control+Shift+G');

    // Expand SCM view if collapsed
    if (await scmTitle.isVisible()) {
        const isExpanded = await scmTitle.getAttribute('aria-expanded');
        if (isExpanded === 'false') {
            await scmTitle.click();
        }
    }

    // Force focus on SCM view pane to ensure widening command applies to the sidebar
    await page.keyboard.press(isMac ? 'Meta+Shift+G' : 'Control+Shift+G');

    // Ensure the sidebar is wide enough
    await ensureSidebarWide(page);

    await expect(async () => {
        // Click the SCM input row to ensure the provider context is active
        await scmInput.click();
    }).toPass({ timeout: 5000 });
    logPerf('focusSCM', start);
}

/**
 * Ensures the JJ Log pane is open and focused.
 */
export async function focusJJLog(page: Page) {
    const start = Date.now();
    const paneLocator = page.locator('.pane-header', { hasText: 'JJ Log' }).first();
    await ensureViewVisible(page, paneLocator, 'Control+Alt+l');

    // Expand the pane if it is collapsed
    const isExpanded = await paneLocator.getAttribute('aria-expanded');
    if (isExpanded === 'false') {
        await paneLocator.click();
    }

    // Force focus on JJ Log view pane to ensure widening command applies to the sidebar
    await page.keyboard.press('Control+Alt+l');

    // Ensure the sidebar is wide enough
    await ensureSidebarWide(page);

    logPerf('focusJJLog', start);
}

/**
 * Waits for a specific tab to become visible and selected.
 */
export async function waitForTab(page: Page, namePattern: RegExp | string): Promise<Locator> {
    const start = Date.now();
    const tab = page.getByRole('tab', { name: namePattern });
    await expect(tab).toBeVisible({ timeout: 10000 });
    logPerf(`waitForTab ${typeof namePattern === 'string' ? namePattern : 'regex'}`, start);
    return tab;
}

/**
 * Helper to retrieve a cached webview frame, verifying it is attached and ready.
 */
async function getCachedWebviewFrame(
    page: Page,
    cache: WeakMap<Page, Frame>,
    predicate: (frame: Frame) => Promise<boolean>,
): Promise<Frame | undefined> {
    const cached = cache.get(page);
    if (!cached) {
        return undefined;
    }
    if (cached.isDetached()) {
        return undefined;
    }
    try {
        if (await predicate(cached)) {
            return cached;
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : '';
        const isPlaywrightError =
            name === 'TimeoutError' ||
            msg.includes('timeout') ||
            msg.includes('Playwright') ||
            msg.includes('Target closed') ||
            msg.includes('Frame was detached');
        if (!isPlaywrightError) {
            console.warn(`[webview-cache] Unexpected error checking cached frame readiness:`, err);
        }
    }
    return undefined;
}

/**
 * Helper to recursively search for an active/visible frame that satisfies the predicate.
 */
async function findFrameWithPredicate(
    frames: ReadonlyArray<Frame>,
    predicate: (frame: Frame) => Promise<boolean>,
): Promise<Frame | undefined> {
    for (const f of frames) {
        try {
            if (await predicate(f)) {
                return f;
            }
            const nested = await findFrameWithPredicate(f.childFrames(), predicate);
            if (nested) {
                return nested;
            }
        } catch {}
    }
    return undefined;
}

const logWebviewCache = new WeakMap<Page, Frame>();

/**
 * Finds the webview frame containing the JJ Log commit rows.
 */
export async function getLogWebview(page: Page, timeout: number = 30000): Promise<Frame> {
    const hasCommitRow = async (f: Frame) => (await f.locator('.commit-row').count()) > 0;
    const cached = await getCachedWebviewFrame(page, logWebviewCache, hasCommitRow);
    if (cached) {
        return cached;
    }

    const start = Date.now();

    // 1. Time pane header check
    const headerStart = Date.now();
    await expect(page.locator('.pane-header', { hasText: 'JJ Log' })).toBeVisible({
        timeout: Math.min(timeout, 300),
    });
    const headerTime = Date.now() - headerStart;

    let framesCount = 0;
    let findTime = 0;

    let guestFrame: Frame | undefined;
    const pollStart = Date.now();
    await expect
        .poll(
            async () => {
                const frames = page.frames();
                framesCount = frames.length;
                const searchStart = Date.now();
                guestFrame = await findFrameWithPredicate(frames, hasCommitRow);
                findTime += Date.now() - searchStart;
                return guestFrame;
            },
            {
                timeout: timeout,
                message: 'Could not find JJ Log webview frame',
            },
        )
        .toBeDefined();

    const pollTime = Date.now() - pollStart;

    if (!guestFrame) {
        throw new Error('Could not find JJ Log webview frame');
    }

    // Ensure the iframe is fully "ready" before returning
    await expect(guestFrame.locator('.commit-row').first()).toBeVisible({ timeout: 10000 });
    logWebviewCache.set(page, guestFrame);
    logPerf(
        'getLogWebview',
        start,
        undefined,
        `(headerCheck: ${headerTime}ms, framesCount: ${framesCount}, findTime: ${findTime}ms, pollTime: ${pollTime}ms)`,
    );
    return guestFrame;
}

/**
 * Asserts that the repo log matches the expected structure.
 */
export async function expectTree(repo: TestRepo, expected: unknown[]) {
    const start = Date.now();
    let lastActual: string[] = [];
    let iterations = 0;
    try {
        await expect
            .poll(
                async () => {
                    iterations++;
                    // Output format: [@] change_id [parent1,parent2] description
                    const log = repo.getLog(
                        'all()',
                        'if(current_working_copy, "@ ", "") ++ change_id ++ " [" ++ parents.map(|p| p.change_id()).join(",") ++ "] " ++ if(description, description.first_line(), "(empty)") ++ "\\n"',
                    );
                    const actual = log
                        .split('\n')
                        .filter((l) => l.trim())
                        .filter((line) => !line.startsWith('zzzzzzzz'));
                    lastActual = actual;
                    return actual;
                },
                {
                    timeout: 10000,
                    message: 'Tree mismatch',
                    intervals: [20, 50, 100, 250, 500],
                },
            )
            .toEqual(
                expected.map((e) => {
                    if (typeof e === 'string' && e.includes('*')) {
                        // Escape regex characters except for our * wildcard
                        const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[a-z0-9]+');
                        return expect.stringMatching(new RegExp(`^${escaped}$`));
                    }
                    return e;
                }),
            );
    } catch (e: unknown) {
        const formatTree = (tree: unknown[]) => tree.map((line) => `  ${String(line)}`).join('\n');
        if (e instanceof Error) {
            e.message = `${e.message}\n\nExpected Tree:\n${formatTree(expected)}\n\nActual Tree:\n${formatTree(lastActual)}`;
        }
        throw e;
    }
    logPerf('expectTree', start, /* prefix= */ undefined, `(iterations: ${iterations})`);
}

/** Helper to format an entry for expectTree */
export function entry(changeId: string, description: string, parents?: string | string[]): string {
    const p = Array.isArray(parents) ? parents.join(',') : parents || '';
    return `${changeId} [${p}] ${description}`;
}

/**
 * Waits for the webview to update and show the given changeId as the current working copy.
 */
export async function waitForWebviewWorkingCopy(page: Page, changeId: string) {
    const start = Date.now();
    const webview = await getLogWebview(page);
    await expect(webview.locator(`[data-change-id="${changeId}"].working-copy`)).toBeVisible({
        timeout: 10000,
    });
    logPerf('waitForWebviewWorkingCopy', start);
}

/**
 * Waits for the webview to update and remove the given changeId.
 */
export async function waitForWebviewCommitRemoved(page: Page, changeId: string) {
    const start = Date.now();
    const webview = await getLogWebview(page);
    await expect(webview.locator(`[data-change-id="${changeId}"]`)).toBeHidden({
        timeout: 10000,
    });
    logPerf('waitForWebviewCommitRemoved', start);
}

/**
 * Robustly selects one or more commit rows in the webview and verifies the selection took effect.
 * Uses aria-selected to verify the React state updated.
 */
export async function selectCommits(rows: Locator[]) {
    const start = Date.now();
    await expect(async () => {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const isSelected = (await row.getAttribute('aria-selected')) === 'true';
            if (!isSelected) {
                await row.click({
                    modifiers: i > 0 ? ['ControlOrMeta'] : undefined,
                    force: true, // Bypasses potential hover overlay issues
                });
            }
            await expect(row).toHaveAttribute('aria-selected', 'true', { timeout: 2000 });
        }

        // Final verification that ALL rows are selected
        for (const row of rows) {
            await expect(row).toHaveAttribute('aria-selected', 'true', { timeout: 500 });
        }
    }, 'Failed to select commits reliably').toPass({ timeout: 20000 });
    logPerf('selectCommits', start);
}

/**
 * Right-clicks a target element and clicks a context menu item by label.
 *
 * VS Code keeps a single `.monaco-menu-container` in the DOM at all times and
 * toggles its `aria-hidden` attribute.  When the menu is **hidden** the element
 * has `aria-hidden="true"`; when open the attribute is **removed** entirely.
 * Playwright's `.isVisible()` treats `aria-hidden="true"` as hidden, which
 * caused false-negatives with the bare `.monaco-menu-container` selector.
 *
 * We use `:not([aria-hidden="true"])` so the locator only matches an open menu.
 */
export async function rightClickAndSelect(page: Page, target: Locator, label: string) {
    const start = Date.now();
    let attempts = 0;
    await expect(async () => {
        attempts++;
        // 1. Trigger the context menu natively
        await target.click({ button: 'right' });

        // Give the menu a moment to open before we look for it
        await page.waitForTimeout(300);

        // 2. Wait for THE item to appear in an open menu.
        // We use a short timeout here to fail FAST and retry the right-click if the menu didn't open.
        const menuContainer = page.locator('.monaco-menu-container:not([aria-hidden="true"])');
        const item = menuContainer.locator('.action-item', { hasText: label }).first();

        await expect(item).toBeVisible({ timeout: 100 });

        const rect = await item.boundingBox();
        if (!rect || rect.height === 0 || rect.width === 0) {
            throw new Error(`Ghost menu detected for ${label}`);
        }

        // 3. Click it directly
        await item.click();
    }, `Failed to execute "${label}" via context menu`).toPass({
        timeout: 30000,
        intervals: [100, 250, 500],
    });
    logPerf(`rightClickAndSelect ${label}`, start, /* prefix= */ undefined, `(attempts: ${attempts})`);
}

/**
 * Simulates a drag and drop action between two locators.
 */
export async function dragAndDrop(page: Page, options: { source: Locator; target: Locator }) {
    const { source, target } = options;
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();

    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();

    if (!sourceBox) {
        throw new Error('Could not get bounding box for source locator');
    }
    if (!targetBox) {
        throw new Error('Could not get bounding box for target locator');
    }

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
}

/**
 * Triggers a manual refresh of the JJ Log view by clicking the refresh button in the view title.
 */
export async function triggerRefresh(page: Page) {
    const start = Date.now();
    // Clear focus from any active iframe/webview to allow top-level keybinding to work.
    await page
        .getByRole('tab', { name: /Explorer/i })
        .first()
        .focus()
        .catch(() => {});

    // Use the custom keybinding registered in launchVSCode
    await page.keyboard.press('Control+Alt+R');

    // Give it a tiny moment to start the refresh process
    await page.waitForTimeout(100);
    logPerf('triggerRefresh', start);
}

export async function hoverAndClick(row: Locator, button: Locator) {
    const start = Date.now();
    const page = row.page();
    await expect(async () => {
        await page.mouse.move(0, 0);
        await row.hover();
        // Wait for the button to be visible because VS Code renders inline actions on hover
        await expect(button).toBeVisible({ timeout: 1000 });
        await button.click({ force: true });
    }, `Failed to click inline action button on row`).toPass({ timeout: 10000 });
    logPerf('hoverAndClick', start);
}

export const SCM_ACTIONS = {
    Abandon: 'Abandon',
    SquashRevisionIntoParent: 'Squash Revision into Parent',
    SquashRevisionIntoAncestor: 'Squash Revision into Ancestor...',
    SquashFilesIntoParent: 'Squash File(s) into Parent',
    SquashFilesIntoAncestor: 'Squash File(s) into Ancestor...',
    SquashFilesIntoChild: 'Squash File(s) into Child',
    Absorb: 'Absorb',
    DiscardChanges: 'Discard Changes',
    ShowDetails: 'Show Details',
    Edit: 'Edit',
    MultiFileDiff: 'Multi-File Diff',
    CompleteSquashRevision: 'Complete Squash Revision',
    FocusRepository: 'Show Repository in JJ Log',
} as const;

/**
 * Robustly clicks an inline action button on an SCM tree item (row or group) by its title.
 */
export async function clickScmAction(page: Page, rowName: string | RegExp, actionTitle: string) {
    const start = Date.now();
    const row = page.getByRole('treeitem', { name: rowName }).first();
    await expect(row).toBeVisible({ timeout: 5000 });

    const iconMap: Record<string, string> = {
        [SCM_ACTIONS.Abandon]: '.codicon-trash',
        [SCM_ACTIONS.SquashRevisionIntoParent]: '.codicon-arrow-down',
        [SCM_ACTIONS.SquashRevisionIntoAncestor]: '.codicon-jj-icon-squash-into',
        [SCM_ACTIONS.SquashFilesIntoParent]: '.codicon-arrow-down',
        [SCM_ACTIONS.SquashFilesIntoAncestor]: '.codicon-jj-icon-squash-into',
        [SCM_ACTIONS.SquashFilesIntoChild]: '.codicon-arrow-up',
        [SCM_ACTIONS.Absorb]: '.codicon-magnet',
        [SCM_ACTIONS.DiscardChanges]: '.codicon-discard',
        [SCM_ACTIONS.ShowDetails]: '.codicon-list-selection',
        [SCM_ACTIONS.Edit]: '.codicon-edit',
        [SCM_ACTIONS.MultiFileDiff]: '.codicon-diff-multiple',
        [SCM_ACTIONS.CompleteSquashRevision]: '.codicon-check',
        [SCM_ACTIONS.FocusRepository]: '.codicon-eye',
    };

    const cls = iconMap[actionTitle];
    let button: Locator;
    if (cls) {
        button = row.locator('.action-item', { has: page.locator(cls) }).first();
    } else {
        button = row.getByRole('button', { name: new RegExp(actionTitle, 'i') }).first();
    }

    await hoverAndClick(row, button);
    logPerf(`clickScmAction ${actionTitle}`, start);
}

/** Helper to trigger Undo across platforms (Meta+z on Mac, Control+z otherwise) */
export async function undo(page: Page) {
    const start = Date.now();
    await page.keyboard.press(isMac ? 'Meta+z' : 'Control+z');
    logPerf('undo', start);
}

/** Helper to trigger Redo across platforms (Meta+Shift+z on Mac, Control+Shift+z otherwise) */
export async function redo(page: Page) {
    const start = Date.now();
    await page.keyboard.press(isMac ? 'Meta+Shift+z' : 'Control+Shift+z');
    logPerf('redo', start);
}

/** Helper to trigger Save across platforms (Meta+s on Mac, Control+s otherwise) */
export async function save(page: Page) {
    const start = Date.now();
    await page.keyboard.press(isMac ? 'Meta+s' : 'Control+s');
    logPerf('save', start);
}

/**
 * Robustly waits for the Settings editor to be open and visible.
 * Handles both traditional tab-based and newer modal-based layouts.
 * Returns the locator for the specific setting item.
 */
export async function expectSettingsOpen(page: Page, settingName: string | RegExp): Promise<Locator> {
    const start = Date.now();
    let settingItem: Locator | undefined;
    await expect(async () => {
        // Look for the settings editor container which is common to both layouts
        const editor = page.locator('.settings-editor');
        await expect(editor).toBeVisible({ timeout: 5000 });

        // The settings editor can be slow to filter or render the item.
        // We search for a .setting-item that contains the text
        settingItem = page.locator('.setting-item').filter({ hasText: settingName });
        await expect(settingItem.first()).toBeVisible({ timeout: 5000 });
    }, `Failed to find Settings editor or specified setting "${settingName}"`).toPass({ timeout: 20000 });

    if (!settingItem) {
        throw new Error(`Failed to find setting item: ${settingName}`);
    }

    logPerf(`expectSettingsOpen ${typeof settingName === 'string' ? settingName : 'regex'}`, start);
    return settingItem.first();
}

/**
 * Robustly sets the description in the SCM input field.
 * Focuses the input using the focusDescriptionInput shortcut,
 * inserts the description text, and validates the input value.
 *
 * @returns The locator targeting the Source Control Input treeitem.
 */
export async function setScmDescription(page: Page, description: string, vscode?: VSCodeFixture): Promise<Locator> {
    const start = Date.now();
    const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' }).first();
    let attempts = 0;

    await expect(async () => {
        attempts++;
        // 1. Ensure the SCM input is visible and focused
        await pressScmShortcut(page);
        await scmInputRow.click();

        // Wait for the native edit context or a textarea to be active
        await page
            .waitForFunction(
                () => {
                    const el = document.activeElement;
                    return el?.getAttribute('role') === 'textbox' || el?.tagName === 'TEXTAREA';
                },
                { timeout: 2000 },
            )
            .catch((err) => {
                console.error('Failed to wait for input to be active:', err);
                throw err;
            });

        // 2. Clear the input
        await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A');
        await page.keyboard.press('Backspace');

        // 3. Set the description
        // Use insertText for speed, but follow up with a validation
        await page.keyboard.insertText(description);

        // 4. Validate that the input editor's text content is exactly what we typed
        const words = description.trim().split(/\s+/).filter(Boolean);
        const regexPattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
        const exactRegex = new RegExp(`^\\s*${regexPattern}\\s*$`);
        await expect(scmInputRow.locator('.monaco-editor')).toHaveText(exactRegex, { timeout: 3000 });

        if (vscode) {
            // Also validate that the Extension Host has received the value.
            // This replaces the need for blind page.waitForTimeout(200) after setScmDescription.
            await expect(async () => {
                const match = await vscode.evaluate(async (_vscode, api, expectedVal) => {
                    const focused = api.repositoryManager.focusedRepository;
                    if (!focused) {
                        return false;
                    }
                    const scmProvider = api.scmProviders.get(focused.rootUri.fsPath);
                    if (!scmProvider) {
                        return false;
                    }
                    return scmProvider.sourceControl.inputBox.value.trim() === (expectedVal as string).trim();
                }, description);
                expect(match).toBe(true);
            }).toPass({ timeout: 2000, intervals: [20, 50, 100] });
        }
    }, `Failed to set SCM description to "${description}" reliably`).toPass({
        timeout: 10000,
        intervals: [100, 250, 500],
    });

    logPerf(`setScmDescription`, start, /* prefix= */ undefined, `(attempts: ${attempts})`);
    return scmInputRow;
}

/**
 * Asserts that the SCM input row contains the expected description.
 * Handles VS Code's text wrapping/concatenation.
 */
export async function expectScmDescription(page: Page, expected: string | RegExp) {
    const start = Date.now();
    const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' }).first();
    if (expected instanceof RegExp) {
        await expect(scmInputRow).toHaveText(expected);
    } else {
        const words = expected.trim().split(/\s+/).filter(Boolean);
        const regexPattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        await expect(scmInputRow).toHaveText(new RegExp(regexPattern));
    }
    logPerf('expectScmDescription', start);
}

/**
 * Locates an SCM tree item, optionally matching a parent group name.
 */
export async function getScmItemLocator(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
    const start = Date.now();
    let result: Locator;
    if (groupName) {
        const allItems = await page.getByRole('treeitem').all();
        let groupIdx = -1;
        const groupNamePattern = groupName instanceof RegExp ? groupName : new RegExp(groupName, 'i');
        const fileNamePattern = fileName instanceof RegExp ? fileName : new RegExp(fileName, 'i');

        for (let i = 0; i < allItems.length; i++) {
            const label = (await allItems[i].getAttribute('aria-label')) || '';
            if (groupNamePattern.test(label)) {
                groupIdx = i;
                break;
            }
        }

        if (groupIdx === -1) {
            throw new Error(`Group "${groupName}" not found`);
        }

        let foundItem: Locator | undefined;
        for (let i = groupIdx + 1; i < allItems.length; i++) {
            const label = (await allItems[i].getAttribute('aria-label')) || '';
            const level = await allItems[i].getAttribute('aria-level');

            if (fileNamePattern.test(label)) {
                foundItem = allItems[i];
                break;
            }

            if (level === '1') {
                throw new Error(`File "${fileName}" not found in group "${groupName}"`);
            }
        }
        if (!foundItem) {
            throw new Error(`File "${fileName}" not found in group "${groupName}"`);
        }
        result = foundItem;
    } else {
        result = page.getByRole('treeitem', { name: fileName }).first();
    }
    logPerf('getScmItemLocator', start);
    return result;
}

/**
 * Asserts that a file matching fileNamePattern is listed under an SCM group matching groupNamePattern.
 */
export async function expectFileInScmGroup(
    page: Page,
    groupNamePattern: RegExp | string,
    fileNamePattern: RegExp | string,
): Promise<Locator> {
    const start = Date.now();
    let locator: Locator | undefined;
    await expect(async () => {
        locator = await getScmItemLocator(page, fileNamePattern, groupNamePattern);
        await expect(locator).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    logPerf('expectFileInScmGroup', start);
    if (!locator) {
        throw new Error(`File "${fileNamePattern}" not found in group "${groupNamePattern}"`);
    }
    return locator;
}

/**
 * Clicks a button in the JJ Log title bar by its name.
 */
export async function clickLogTitleButton(page: Page, name: string) {
    const start = Date.now();
    const header = page.locator('.pane-header', { hasText: 'JJ Log' }).first();
    const button = header.getByRole('button', { name });
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();
    logPerf(`clickLogTitleButton ${name}`, start);
}

/**
 * Clicks a button within a notification toast.
 */
export async function clickNotificationButton(page: Page, actionLabel: string) {
    const start = Date.now();
    await expect(async () => {
        const toast = page.locator('.notifications-toasts .notification-toast');
        const button = toast.getByRole('button', { name: actionLabel });
        await expect(button).toBeVisible({ timeout: 2000 });
        await button.click();
    }, `Failed to click notification button "${actionLabel}"`).toPass({ timeout: 15000 });
    logPerf(`clickNotificationButton ${actionLabel}`, start);
}

/**
 * Waits for a notification toast containing the expected text to be visible.
 */
export async function expectNotificationToast(page: Page, text: string | RegExp, timeout = 10000) {
    const start = Date.now();
    const toast = page.locator('.notifications-toasts .notification-toast');
    await expect(toast.filter({ hasText: text }).first()).toBeVisible({ timeout });
    logPerf('expectNotificationToast', start);
}

/**
 * Polls the window title until it matches/contains the expected string or RegExp.
 * Gracefully handles execution context unloads during page/frame navigations.
 */
export async function expectWindowTitle(page: Page, expected: string | RegExp, timeout = 15000) {
    const start = Date.now();
    await expect
        .poll(
            async () => {
                try {
                    return await page.title();
                } catch {
                    return '';
                }
            },
            { timeout },
        )
        .toMatch(expected);
    logPerf('expectWindowTitle', start);
}

/**
 * Returns the locator for the active QuickInput widget.
 */
export function locateQuickInputWidget(page: Page): Locator {
    return page.locator('.quick-input-widget');
}

/**
 * Returns the locator for a specific item in the active QuickInput widget.
 */
export function locateQuickInputItem(page: Page, label: string | RegExp): Locator {
    return locateQuickInputWidget(page).locator('.monaco-list-row').filter({ hasText: label });
}

/**
 * Waits for the VS Code QuickInput widget to be visible and returns the input locator.
 */
export async function waitForQuickInput(page: Page, timeout: number = 10000): Promise<Locator> {
    const start = Date.now();
    const quickInput = locateQuickInputWidget(page).filter({ visible: true });
    const input = quickInput.locator('input.input');
    await expect(input).toBeVisible({ timeout });
    logPerf('waitForQuickInput', start);
    return input;
}

/**
 * Robustly presses a shortcut key to open the QuickInput widget, retrying if VS Code ignores the keypress.
 */
export async function openQuickInputWithShortcut(page: Page, shortcut: string): Promise<Locator> {
    const start = Date.now();
    const quickInput = locateQuickInputWidget(page);
    const input = quickInput.locator('input.input');

    // Ensure any leftover quick input is closed first
    if (await quickInput.isVisible()) {
        await page.keyboard.press('Escape');
    }
    await expect(quickInput).not.toBeVisible({ timeout: 2000 });

    await expect(async () => {
        if (!(await input.isVisible())) {
            // Clear focus from any active iframe/webview to allow top-level keybinding to work.
            // Blurring activeElement directly doesn't work if focus is trapped inside a webview iframe
            // within VS Code's shadow DOM. Focusing a top-level tab steals focus back to the main window.
            await page
                .getByRole('tab', { name: /Explorer/i })
                .first()
                .focus()
                .catch(() => {});
            await page.keyboard.press(shortcut);
        }
        await waitForQuickInput(page, 200);
    }, `Failed to open quick input via shortcut "${shortcut}"`).toPass({ timeout: 5000 });
    logPerf(`openQuickInputWithShortcut ${shortcut}`, start);
    return input;
}

export type LogPillKind = 'bookmark' | 'workspace' | 'tag' | 'remote-bookmark';

/**
 * Robustly waits for a bookmark or workspace pill to be visible in the JJ Log webview.
 * Handles webview reloads by re-fetching the frame on each retry.
 */
export async function waitForLogPill(page: Page, label: string, kind?: LogPillKind): Promise<Locator> {
    const start = Date.now();
    let pill: Locator | undefined;
    let attempts = 0;
    await expect(
        async () => {
            attempts++;
            const webview = await getLogWebview(page, 300);
            let selector = '.bookmark-pill';
            if (kind === 'bookmark') {
                selector += ':has(.codicon-bookmark)';
            } else if (kind === 'tag') {
                selector += ':has(.codicon-tag)';
            }

            pill = webview.locator(selector, { hasText: label });

            const isVisible = await pill.isVisible();
            if (!isVisible && attempts > 1 && attempts % 5 === 0) {
                // Try a manual refresh if we've been waiting and it's not showing up
                await triggerRefresh(page);
            }

            await expect(pill).toBeVisible({ timeout: 500 });
        },
        `Failed to find log ${kind || 'pill'} with text "${label}"`,
    ).toPass({
        timeout: 20000,
        intervals: [50, 100, 250, 500],
    });

    if (!pill) {
        throw new Error(`Failed to find log ${kind || 'pill'} with text "${label}"`);
    }
    logPerf(`waitForLogPill ${label}`, start, /* prefix= */ undefined, `(attempts: ${attempts})`);
    return pill;
}

export type LogRowCriteria = string | RegExp | { changeId?: string; text?: string | RegExp };

/**
 * Robustly finds a commit row in the JJ Log webview by its text content or changeId attribute.
 * Handles webview reloads by re-fetching the frame on retry.
 */
export async function waitForLogCommitRow(page: Page, criteria: LogRowCriteria, repo?: TestRepo): Promise<Locator> {
    const start = Date.now();
    let row: Locator | undefined;
    let attempts = 0;
    try {
        await expect(
            async () => {
                attempts++;
                const webview = await getLogWebview(page, 300);
                if (typeof criteria === 'object' && !(criteria instanceof RegExp)) {
                    if (criteria.changeId) {
                        row = webview.locator(`[data-change-id="${criteria.changeId}"]`);
                    } else {
                        row = webview.locator('.commit-row', { hasText: criteria.text });
                    }
                } else {
                    row = webview.locator('.commit-row', { hasText: criteria as string | RegExp });
                }
                // Fast check for visibility
                await expect(row).toBeVisible({ timeout: 200 });
            },
            `Failed to find log row matching ${JSON.stringify(criteria)}`,
        ).toPass({
            timeout: 20000,
            intervals: [50, 100, 250, 500],
        });
    } catch (e) {
        if (repo) {
            const logState = repo.getLog('all()', 'change_id ++ " " ++ description.first_line()');
            console.log(`[jj-view Test Diagnostic] Current Repo Log:\n`, logState);
        }
        try {
            const webview = await getLogWebview(page, 300);
            const content = await webview.innerText('body');
            console.log(
                '[jj-view Test Diagnostic] Webview body text content (first 500 chars):\n',
                content.substring(0, 500),
            );
        } catch (_innerError) {
            console.log('[jj-view Test Diagnostic] Could not fetch webview content for diagnostics.');
        }
        throw e;
    }
    if (!row) {
        throw new Error(`Failed to find log row matching ${JSON.stringify(criteria)}`);
    }
    logPerf(
        `waitForLogCommitRow ${typeof criteria === 'string' ? criteria : 'object'}`,
        start,
        /* prefix= */ undefined,
        `(attempts: ${attempts})`,
    );
    return row;
}

export async function clickLogAction(page: Page, rowCriteria: LogRowCriteria, actionTitle: string, repo?: TestRepo) {
    const start = Date.now();
    let iterations = 0;
    await expect(
        async () => {
            iterations++;
            const row = await waitForLogCommitRow(page, rowCriteria, repo);
            await page.mouse.move(0, 0);
            await row.hover();

            const button = row.locator(`[title="${actionTitle}"]`);
            await expect(button).toBeVisible({ timeout: 1000 });
            await button.click({ force: true });
        },
        `Failed to click action "${actionTitle}" on row matching ${JSON.stringify(rowCriteria)}`,
    ).toPass({
        timeout: 20000,
        intervals: [50, 100, 250, 500],
    });
    logPerf(`clickLogAction ${actionTitle}`, start, /* prefix= */ undefined, `(iterations: ${iterations})`);
}

/**
 * Verifies that the multi-file diff view lists exactly the expected modified files.
 */
export async function expectModifiedFiles(page: Page, expectedFiles: string[]) {
    const start = Date.now();
    await expect
        .poll(async () => {
            return await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('.file-path .title.modified .label-name'));
                return elements.map((el) => el.textContent?.trim()).filter(Boolean);
            });
        }, 'Wait for exactly modified files list in multi-diff')
        .toEqual(expectedFiles);
    logPerf('expectModifiedFiles', start);
}

/**
 * Robustly opens a file via the File Explorer tree view.
 * Pass the `repo` object to enable deep filesystem vs UI diagnostic dumping on failure.
 */
export async function openFileInEditor(
    vscode: FixtureVSCodeFixture,
    page: Page,
    fileName: string,
    repo?: TestRepo,
): Promise<Locator> {
    const start = Date.now();
    const tab = page.getByRole('tab', { name: fileName, selected: true });
    const editor = page.locator('.editor-instance .monaco-editor').first();

    let attempt = 0;
    let lastDiagnosticLogs: string[] = []; // Store logs outside the retry loop

    try {
        await expect(async () => {
            attempt++;
            const logs: string[] = [];
            const log = (msg: string) => logs.push(`[Attempt ${attempt}] ${msg}`);
            lastDiagnosticLogs = logs; // Update outer reference on every attempt

            // 1. If it's already open and perfectly set up, exit early
            if ((await tab.isVisible()) && (await editor.isVisible())) {
                return;
            }

            // 3. Use programmatic helper to open the file
            log(`Opening file "${fileName}" programmatically...`);
            const absolutePath = repo ? path.resolve(repo.path, fileName) : fileName;
            await vscode.openFileInEditor(absolutePath);

            // 4. Wait for the tab to become active and the Monaco editor to mount
            log(`Waiting for editor to mount...`);
            await expect(tab).toBeVisible({ timeout: 5000 });
            await expect(editor).toBeVisible({ timeout: 5000 });
        }).toPass({
            timeout: 30000,
            intervals: [250, 500, 1000],
        });
    } catch (error: unknown) {
        // INJECT THE LOGS DIRECTLY INTO THE PLAYWRIGHT TIMEOUT ERROR
        if (error instanceof Error) {
            let repoDiagnostics = '';
            if (repo) {
                try {
                    const files = repo.listFiles('@');
                    repoDiagnostics = `\n\n--- REPO FILES ---\n${files.join('\n')}`;
                } catch (e) {
                    repoDiagnostics = `\n\n--- REPO FILES ---\nFailed to list files: ${String(e)}`;
                }
            }
            error.message =
                'Failed to open file "' +
                fileName +
                '" in editor.\n' +
                error.message +
                '\n\n--- DIAGNOSTIC DUMP (Last Attempt) ---\n' +
                lastDiagnosticLogs.join('\n') +
                repoDiagnostics;
        }
        throw error;
    }

    logPerf(`openFileInEditor ${fileName}`, start, /* prefix= */ undefined, `(attempts: ${attempt})`);
    return editor;
}

/**
 * Robustly opens a file diff from the SCM pane by clicking its tree item.
 */
export async function openScmDiff(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
    const start = Date.now();
    const result = await openScmItem(page, fileName, '.monaco-diff-editor', groupName);
    logPerf(`openScmDiff ${typeof fileName === 'string' ? fileName : 'regex'}`, start);
    return result;
}

/**
 * Robustly opens a conflict merge editor from the SCM pane.
 */
export async function openScmMerge(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
    const start = Date.now();
    const result = await openScmItem(page, fileName, '.merge-editor', groupName);
    logPerf(`openScmMerge ${typeof fileName === 'string' ? fileName : 'regex'}`, start);
    return result;
}

/**
 * Robustly opens a file (regular editor) from the SCM pane by clicking its tree item.
 */
export async function openScmFile(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
    const start = Date.now();
    const result = await openScmItem(page, fileName, '.editor-instance .monaco-editor', groupName);
    logPerf(`openScmFile ${typeof fileName === 'string' ? fileName : 'regex'}`, start);
    return result;
}

/**
 * Internal helper for opening files from the SCM pane.
 */
async function openScmItem(
    page: Page,
    fileName: string | RegExp,
    editorSelector: string,
    groupName?: string | RegExp,
): Promise<Locator> {
    const start = Date.now();
    let row: Locator | undefined;
    await expect(
        async () => {
            await focusSCM(page);

            row = await getScmItemLocator(page, fileName, groupName);

            if (!row) {
                throw new Error(`File "${fileName}" not found`);
            }

            await expect(row).toBeVisible({ timeout: 5000 });
            await row.click();

            // Wait for the specific editor to appear. Use .first() to avoid strict mode violations
            // if multiple editors (like SCM input) are present.
            await expect(page.locator(editorSelector).first()).toBeVisible({ timeout: 10000 });

            // Wait for the tab to be active
            await waitForTab(page, fileName);
        },
        `Failed to open SCM item "${fileName}" in editor "${editorSelector}"${groupName ? ` in group "${groupName}"` : ''}`,
    ).toPass({ timeout: 20000 });

    if (!row) {
        throw new Error('Row not found after toPass completion');
    }
    logPerf(`openScmItem ${typeof fileName === 'string' ? fileName : 'regex'}`, start);
    return row;
}

const detailsWebviewCache = new WeakMap<Page, Frame>();

/**
 * Finds the webview frame containing the Commit Details panel.
 * Re-fetches frames on poll to handle detached frames.
 */
export async function getDetailsWebview(page: Page): Promise<Frame> {
    const isTextareaVisible = async (f: Frame) => await f.locator('textarea').isVisible({ timeout: 50 });
    const cached = await getCachedWebviewFrame(page, detailsWebviewCache, isTextareaVisible);
    if (cached) {
        return cached;
    }

    const start = Date.now();

    let guestFrame: Frame | undefined;
    await expect
        .poll(
            async () => {
                guestFrame = await findFrameWithPredicate(page.frames(), isTextareaVisible);
                return guestFrame;
            },
            {
                timeout: 30000,
                message: 'Could not find Commit Details webview frame',
            },
        )
        .toBeDefined();

    if (!guestFrame) {
        throw new Error('Could not find Commit Details webview frame');
    }

    // Ensure the iframe is fully "ready" before returning
    await expect(guestFrame.locator('textarea')).toBeVisible({ timeout: 10000 });
    detailsWebviewCache.set(page, guestFrame);
    logPerf('getDetailsWebview', start);
    return guestFrame;
}

export async function pickQuickPickItem(
    page: Page,
    label: string | RegExp,
    options?: { submitAsArbitraryText?: boolean },
) {
    const start = Date.now();
    await expect(async () => {
        const quickInput = locateQuickInputWidget(page).filter({ visible: true });
        const input = quickInput.locator('input.input');

        await expect(input).toBeVisible({ timeout: 5000 });

        if (typeof label === 'string') {
            await input.focus();

            // Clear the input natively
            await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A');
            await page.keyboard.press('Backspace');

            // Type exactly like a human to ensure VS Code's internal state catches the text
            await input.pressSequentially(label, { delay: 1 });

            await expect(input).toHaveValue(label, { timeout: 2000 });
        }

        if (options?.submitAsArbitraryText) {
            // Wait for any background fetching/validation to finish.
            // VS Code shows a progress bar when extensions are fetching async data.
            const progressBar = quickInput.locator('.monaco-progress-container.active');
            await expect(progressBar)
                .toBeHidden({ timeout: 5000 })
                .catch(() => {});

            // Give the VS Code debouncer a little time to flush the state
            await page.waitForTimeout(200);

            // Fire native Enter
            await page.keyboard.press('Enter');

            // Verify it closed
            await expect(quickInput).not.toBeVisible({ timeout: 5000 });
        } else {
            const item = locateQuickInputItem(page, label).first();
            await expect(item).toBeVisible({ timeout: 1000 });
            await item.click();
            await expect(item).not.toBeVisible({ timeout: 500 });
        }
    }, `Failed to pick QuickPick item "${label}"`).toPass({
        timeout: 5000,
        // Add a backoff so we don't spam if the UI is genuinely stuck
        intervals: [100, 250, 500, 1000, 2000],
    });
    logPerf(`pickQuickPickItem ${typeof label === 'string' ? label : 'regex'}`, start);
}

/**
 * Selects an entire line of text in an editor by its content.
 */
export async function selectLine(page: Page, editor: Locator, text: string | RegExp): Promise<Locator> {
    const start = Date.now();
    const line = editor.getByText(text).first();
    await line.click();

    const cmdKey = isMac ? 'Meta' : 'Control';
    await page.keyboard.down(cmdKey);
    await page.keyboard.press('l');
    await page.keyboard.up(cmdKey);

    logPerf('selectLine', start);
    return line;
}

/**
 * Clicks an item in an open context menu.
 */
export async function clickContextMenuItem(page: Page, label: string | RegExp) {
    const start = Date.now();
    await expect(async () => {
        const menu = page.locator('.monaco-menu-container');
        await expect(menu).toBeVisible({ timeout: 2000 });

        const item = menu.locator('.action-item').filter({ hasText: label }).first();
        await expect(item).toBeVisible({ timeout: 1000 });

        // Settle, then click
        await page.waitForTimeout(200);
        await item.click();

        // Wait for menu to disappear
        await expect(menu).not.toBeVisible({ timeout: 2000 });
    }, `Failed to click context menu item "${label}"`).toPass({ timeout: 5000 });
    logPerf(`clickContextMenuItem ${typeof label === 'string' ? label : 'regex'}`, start);
}

/**
 * Saves the active editor using the platform-specific shortcut.
 */
export async function saveActiveEditor(page: Page) {
    const start = Date.now();
    await page.keyboard.press(isMac ? 'Meta+s' : 'Control+s');
    logPerf('saveActiveEditor', start);
}

/**
 * Clears all text in the active editor.
 */
export async function clearActiveEditor(page: Page) {
    const start = Date.now();
    await page.keyboard.press(isMac ? 'Meta+a' : 'Control+a');
    await page.keyboard.press('Backspace');
    logPerf('clearActiveEditor', start);
}

/**
 * Closes the active editor using the platform-specific shortcut.
 */
export async function closeActiveEditor(page: Page) {
    const start = Date.now();
    await page.keyboard.press(isMac ? 'Meta+w' : 'Control+w');
    logPerf('closeActiveEditor', start);
}

/**
 * Asserts that a badge link exists inside a commit row and points to the correct URL.
 */
export async function expectBadgeLink(row: Locator, hasText: string, expectedUrl: string) {
    const start = Date.now();
    const badgeLink = row.locator('a', { hasText });
    await expect(badgeLink).toBeVisible({
        timeout: 20000,
    });
    await expect(badgeLink).toHaveAttribute('href', expectedUrl);
    logPerf('expectBadgeLink', start);
}

/**
 * Prints the extension's logs from the VS Code user data directory if the test failed.
 */
export function maybePrintExtensionLogs(userDataDir: string) {
    try {
        const testInfo = test.info();
        if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
            const findJjViewLog = (dir: string): string | undefined => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        const found = findJjViewLog(fullPath);
                        if (found) {
                            return found;
                        }
                    } else if (entry.name.includes('JJ View') && entry.name.endsWith('.log')) {
                        return fullPath;
                    }
                }
                return undefined;
            };
            const logFile = findJjViewLog(userDataDir);
            if (logFile) {
                console.log('--- JJ VIEW OUTPUT CHANNEL LOG ---');
                console.log(fs.readFileSync(logFile, 'utf8'));
                console.log('----------------------------------');
            } else {
                console.log('Could not find JJ View log file in', userDataDir);
            }
        }
    } catch (err) {
        console.error('Failed to read logs:', err);
    }
}

/**
 * Polls the repository until the bookmark points to the expected commit ID.
 */
export async function waitForBookmark(
    repo: TestRepo,
    name: string,
    expectedCommitId: string,
    options: { timeout?: number; remoteRepo?: TestRepo } = {},
) {
    await expect
        .poll(
            async () => {
                try {
                    if (options.remoteRepo) {
                        options.remoteRepo.gitImport();
                        return options.remoteRepo.getCommitId(name) === expectedCommitId;
                    }
                    return repo.getCommitId(name) === expectedCommitId;
                } catch {
                    return false;
                }
            },
            { timeout: options.timeout ?? 10000 },
        )
        .toBe(true);
}

/**
 * Locates the comment review widget in the editor and waits for it to become visible.
 */
export async function getReviewWidget(page: Page, expectedText?: string): Promise<Locator> {
    const start = Date.now();
    const reviewWidget = page.locator('.review-widget');
    await expect(reviewWidget).toBeVisible({ timeout: 15000 });
    if (expectedText) {
        await expect(reviewWidget).toContainText(expectedText);
    }
    logPerf('getReviewWidget', start);
    return reviewWidget;
}

/**
 * Expands the comment reply input form if it is not already visible.
 */
async function expandReplyFormIfNeeded(reviewWidget: Locator) {
    const replyPlaceholderBtn = reviewWidget.locator('.review-thread-reply-button');
    if (await replyPlaceholderBtn.isVisible()) {
        await replyPlaceholderBtn.click();
    }
}

/**
 * Clicks a button in the form actions of a comment thread review widget.
 */
async function clickCommentButton(reviewWidget: Locator, buttonLabel: string | RegExp, perfLabel: string) {
    const start = Date.now();
    await expandReplyFormIfNeeded(reviewWidget);

    const button = reviewWidget
        .locator('.form-actions button, .form-actions [role="button"]')
        .filter({ hasText: buttonLabel })
        .first();
    await expect(button).toBeVisible();
    await button.click();
    logPerf(perfLabel, start);
}

/**
 * Types text into the reply input and clicks a button in the form actions.
 */
async function submitTypedCommentReply(
    page: Page,
    reviewWidget: Locator,
    text: string,
    buttonLabel: string | RegExp,
    perfLabel: string,
) {
    const start = Date.now();
    await expandReplyFormIfNeeded(reviewWidget);

    const editor = reviewWidget.locator('.comment-form .monaco-editor');
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type(text);

    const button = reviewWidget
        .locator('.form-actions button, .form-actions [role="button"]')
        .filter({ hasText: buttonLabel })
        .first();
    await expect(button).toBeVisible();
    await button.click();
    logPerf(perfLabel, start);
}

/**
 * Types and submits a reply on the given comment thread review widget.
 */
export async function replyToCommentThread(page: Page, reviewWidget: Locator, text: string) {
    await submitTypedCommentReply(page, reviewWidget, text, /^Reply$/, 'replyToCommentThread');
}

/**
 * Resolves the given comment thread review widget by clicking the resolve button next to Reply.
 */
export async function resolveCommentThread(reviewWidget: Locator) {
    await clickCommentButton(reviewWidget, 'Resolve Thread', 'resolveCommentThread');
}

/**
 * Unresolves the given comment thread review widget by clicking the unresolve button next to Reply.
 */
export async function unresolveCommentThread(reviewWidget: Locator) {
    await clickCommentButton(reviewWidget, 'Unresolve Thread', 'unresolveCommentThread');
}

/**
 * Polls the comments manager until the count of loaded comment threads is at least minCount.
 */
export async function waitForCommentThreadsCount(vscode: VSCodeFixture, minCount = 1) {
    await expect
        .poll(async () => {
            return await vscode.evaluate((_, api) => {
                return api.commentsManager.getThreads().size;
            });
        })
        .toBeGreaterThanOrEqual(minCount);
}

/**
 * Polls the first comment thread until its resolution status and collapsible state match the expected values.
 */
export async function waitForThreadState(
    vscode: VSCodeFixture,
    expectedContextValue: 'resolved' | 'unresolved',
    expectedCollapsibleState: 0 | 1,
) {
    await expect
        .poll(async () => {
            return await vscode.evaluate((_, api) => {
                const thread = Array.from(api.commentsManager.getThreads().values())[0];
                return {
                    contextValue: thread?.contextValue,
                    collapsibleState: thread?.collapsibleState,
                };
            });
        })
        .toEqual({
            contextValue: expectedContextValue,
            collapsibleState: expectedCollapsibleState,
        });
}

/**
 * Clicks the "Ack" button on the given comment thread review widget.
 */
export async function replyWithAck(reviewWidget: Locator) {
    await clickCommentButton(reviewWidget, 'Ack', 'replyWithAck');
}

/**
 * Clicks the "Done" button on the given comment thread review widget.
 */
export async function replyWithDone(reviewWidget: Locator) {
    await clickCommentButton(reviewWidget, 'Done', 'replyWithDone');
}

/**
 * Types text and clicks the "Reply & Resolve" button on the given comment thread review widget.
 */
export async function replyAndResolve(page: Page, reviewWidget: Locator, text: string) {
    await submitTypedCommentReply(page, reviewWidget, text, 'Reply & Resolve', 'replyAndResolve');
}
