/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, type Locator } from '@playwright/test';
import { downloadAndUnzipVSCode, SilentReporter } from '@vscode/test-electron';
import { type ElectronApplication, _electron as electron, type Frame, type Page } from 'playwright';
import type { TestRepo } from '../test-repo';

export const ROOT_ID = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

export interface VSCodeContext {
    app: ElectronApplication;
    page: Page;
    userDataDir: string;
}

/**
 * Standard setup for VS Code E2E tests.
 * Initializes a user data directory with common settings and launches VS Code.
 * Renamed to launchVSCode to avoid confusion with local setup functions in specs.
 */
export async function launchVSCode(
    repo: TestRepo,
    extraSettings: Record<string, unknown> = {},
    extraEnv: Record<string, string | undefined> = {},
    showNotifications = false,
): Promise<VSCodeContext> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-user-data-'));
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-extensions-'));
    const userSettingsDir = path.join(userDataDir, 'User');
    fs.mkdirSync(userSettingsDir, { recursive: true });

    fs.writeFileSync(
        path.join(userSettingsDir, 'settings.json'),
        JSON.stringify(
            {
                'workbench.colorTheme': 'Default Dark Modern',
                'git.enabled': false,
                'workbench.startupEditor': 'none',
                'workbench.sideBar.location': 'left',
                'scm.alwaysShowProviders': true,
                'scm.alwaysShowActions': true,
                'workbench.tips.enabled': false,
                'window.titleBarStyle': 'custom',
                'window.dialogStyle': 'custom',
                'security.workspace.trust.enabled': false,
                'jj-view.fileWatcherMode': 'watch',
                'jj-view.minChangeIdLength': 3,
                'telemetry.telemetryLevel': 'off',
                'workbench.notification.displayMode': showNotifications ? 'default' : 'hidden',
                'notifications.showDoNotDisturb': !showNotifications,
                'update.mode': 'none',
                'extensions.autoCheckUpdates': false,
                'extensions.autoUpdate': false,
                'explorer.excludeGitIgnore': false,
                ...extraSettings,
            },
            null,
            2,
        ),
    );

    fs.writeFileSync(
        path.join(userSettingsDir, 'keybindings.json'),
        JSON.stringify(
            [
                {
                    key: 'ctrl+alt+l',
                    command: 'jj-view.logView.focus',
                },
                {
                    key: 'ctrl+alt+r',
                    command: 'jj-view.refresh',
                },
                {
                    key: 'ctrl+alt+e',
                    command: 'workbench.files.action.refreshFilesExplorer',
                },
                {
                    key: 'ctrl+alt+c',
                    command: 'jj-view.compareWithWorkingCopy',
                },
                {
                    key: 'ctrl+alt+f',
                    command: 'jj-view.compareFileWith',
                },
            ],
            null,
            2,
        ),
    );

    const extensionPath = path.resolve(__dirname, '../../../');
    const vscodePath = await downloadAndUnzipVSCode({ reporter: new SilentReporter() });

    const args = [
        repo.path,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--new-window',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-updates',
    ];

    if (process.env.VSIX_PATH) {
        const vsixPath = path.resolve(process.env.VSIX_PATH);
        if (!fs.existsSync(vsixPath)) {
            throw new Error(`VSIX_PATH is set but file does not exist: ${vsixPath}`);
        }
        // Import utilities from @vscode/test-electron to find the CLI path
        const { resolveCliPathFromVSCodeExecutablePath } = await import('@vscode/test-electron');
        const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodePath);

        // Install the extension via CLI
        const { spawnSync } = await import('node:child_process');
        console.log(`Installing VSIX from ${vsixPath} using CLI ${cliPath}...`);
        const result = spawnSync(cliPath, ['--install-extension', vsixPath, '--extensions-dir', extensionsDir], {
            encoding: 'utf-8',
            stdio: 'inherit',
        });

        if (result.status !== 0) {
            throw new Error(`Failed to install extension VSIX: ${result.stderr || result.error}`);
        }
    } else {
        args.push(`--extensionDevelopmentPath=${extensionPath}`);
        args.push('--disable-extensions'); // Only disable other extensions when running from source
    }

    const env = { ...process.env } as { [key: string]: string };
    for (const key in extraEnv) {
        const val = extraEnv[key];
        if (val === undefined) {
            delete env[key];
        } else {
            env[key] = val;
        }
    }

    const app = await electron.launch({
        executablePath: vscodePath,
        args,
        env,
    });

    const page = await app.firstWindow();

    // Capture page console logs for debugging if verbose mode is enabled
    if (process.env.VERBOSE) {
        page.on('console', (msg) => {
            console.log(`PAGE LOG: ${msg.text()}`);
        });
        page.on('pageerror', (err) => console.error(`PAGE ERROR: ${err.message}`));
    }

    // Wait for the workbench to be ready
    await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 15000 });

    // Hide notification toasts via CSS unless requested. Error-level toasts (e.g. "failed to load
    // extension") bypass VS Code's Do Not Disturb / displayMode settings and can
    // overlay buttons, causing click interception in tests.
    if (!showNotifications) {
        await page.addStyleTag({ content: '.notifications-toasts { display: none !important; }' });
    }

    return { app, page, userDataDir };
}

/**
 * Ensures the SCM view is open.
 */
export async function focusSCM(page: Page) {
    await expect(async () => {
        // Control+Shift+G is the standard VS Code shortcut to show/focus Source Control
        await page.keyboard.press('Control+Shift+G');

        // Wait for either the input row or the side bar title to be visible
        const scmTitle = page.locator('.pane-header', { hasText: 'Source Control' }).first();
        const scmInput = page.getByRole('treeitem', { name: 'Source Control Input' });

        await expect(scmTitle.or(scmInput)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
}

/**
 * Ensures the JJ Log pane is open and focused.
 */
export async function focusJJLog(page: Page) {
    await expect(async () => {
        await page.keyboard.press('Control+Alt+l');
        // Check if the pane header appears
        await expect(page.locator('.pane-header', { hasText: 'JJ Log' }).first()).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });
}

/**
 * Waits for a specific tab to become visible and selected.
 */
export async function waitForTab(page: Page, namePattern: RegExp | string): Promise<Locator> {
    const tab = page.getByRole('tab', { name: namePattern });
    await expect(tab).toBeVisible({ timeout: 10000 });
    return tab;
}

/**
 * Finds the webview frame containing the JJ Log commit rows.
 */
export async function getLogWebview(page: Page, timeout: number = 30000): Promise<Frame> {
    // The panel header
    await expect(page.locator('.pane-header', { hasText: 'JJ Log' })).toBeVisible({
        timeout: Math.min(timeout, 300),
    });

    async function findFrameWithSelector(frames: ReadonlyArray<Frame>, selector: string): Promise<Frame | undefined> {
        for (const f of frames) {
            try {
                if ((await f.locator(selector).count()) > 0) {
                    return f;
                }
                const nested = await findFrameWithSelector(f.childFrames(), selector);
                if (nested) {
                    return nested;
                }
            } catch (_) {}
        }
        return undefined;
    }

    let guestFrame: Frame | undefined;
    await expect
        .poll(
            async () => {
                guestFrame = await findFrameWithSelector(page.frames(), '.commit-row');
                return guestFrame;
            },
            {
                timeout: timeout,
                message: 'Could not find JJ Log webview frame',
            },
        )
        .toBeDefined();

    if (!guestFrame) {
        throw new Error('Could not find JJ Log webview frame');
    }
    return guestFrame;
}

/**
 * Asserts that the repo log matches the expected structure.
 */
export async function expectTree(repo: TestRepo, expected: unknown[]) {
    let lastActual: string[] = [];
    try {
        await expect
            .poll(
                async () => {
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
}

/** Helper to format an entry for expectTree */
export function entry(changeId: string, description: string, parents?: string | string[]): string {
    const p = Array.isArray(parents) ? parents.join(',') : parents || '';
    return `${changeId} [${p}] ${description}`;
}

/**
 * Robustly selects one or more commit rows in the webview and verifies the selection took effect.
 * Uses aria-selected to verify the React state updated.
 */
export async function selectCommits(rows: Locator[]) {
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
    await expect(async () => {
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
    }, `Failed to execute "${label}" via context menu`).toPass({ timeout: 30000 });
}

/**
 * Triggers a manual refresh of the JJ Log view by clicking the refresh button in the view title.
 */
export async function triggerRefresh(page: Page) {
    // Use the custom keybinding registered in launchVSCode
    await page.keyboard.press('Control+Alt+R');

    // Give it a tiny moment to start the refresh process
    await page.waitForTimeout(100);
}

/**
 * Hovers over a row and clicks an inline action button.
 * VS Code inline actions only appear on hover, and sometimes the hover state
 * is transient or flakey, so we retry the hover+click sequence.
 */
export async function hoverAndClick(row: Locator, button: Locator) {
    await expect(async () => {
        await row.hover();
        // Wait for the button to be visible because VS Code renders inline actions on hover
        await expect(button).toBeVisible({ timeout: 1000 });
        await button.click({ force: true });
    }, `Failed to click inline action button on row`).toPass({ timeout: 10000 });
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
} as const;

/**
 * Robustly clicks an inline action button on an SCM tree item (row or group) by its title.
 */
export async function clickScmAction(page: Page, rowName: string | RegExp, actionTitle: string) {
    await expect(async () => {
        const row = page.getByRole('treeitem', { name: rowName }).first();
        await expect(row).toBeVisible({ timeout: 5000 });
        await row.hover();
        await page.waitForTimeout(500); // Give it more time to settle

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
        };

        const cls = iconMap[actionTitle];
        let button: Locator;

        if (cls) {
            button = row.locator('.action-item', { has: page.locator(cls) }).first();
        } else {
            button = row.getByRole('button', { name: new RegExp(actionTitle, 'i') }).first();
        }

        // Fallback: If not found by class, try finding by name
        if (cls && !(await button.isVisible())) {
            button = row.getByRole('button', { name: new RegExp(actionTitle, 'i') }).first();
        }

        await expect(button).toBeVisible({ timeout: 1000 });
        await button.click({ force: true });
    }, `Failed to click SCM action "${actionTitle}" on row "${rowName}"`).toPass({ timeout: 10000 });
}

export const isMac = process.platform === 'darwin';

/** Helper to trigger Undo across platforms (Meta+z on Mac, Control+z otherwise) */
export async function undo(page: Page) {
    await page.keyboard.press(isMac ? 'Meta+z' : 'Control+z');
}

/** Helper to trigger Redo across platforms (Meta+Shift+z on Mac, Control+Shift+z otherwise) */
export async function redo(page: Page) {
    await page.keyboard.press(isMac ? 'Meta+Shift+z' : 'Control+Shift+z');
}

/** Helper to trigger Save across platforms (Meta+s on Mac, Control+s otherwise) */
export async function save(page: Page) {
    await page.keyboard.press(isMac ? 'Meta+s' : 'Control+s');
}

/**
 * Robustly waits for the Settings editor to be open and visible.
 * Handles both traditional tab-based and newer modal-based layouts.
 * Returns the locator for the specific setting item.
 */
export async function expectSettingsOpen(page: Page, settingName: string | RegExp): Promise<Locator> {
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

    return settingItem.first();
}

/**
 * Robustly sets the description in the SCM input field.
 * Uses Playwright's .fill() most of the time, but includes
 * explicit validation to prevent partial/mangled entries.
 */
export async function setScmDescription(page: Page, description: string) {
    const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' });

    await expect(async () => {
        // 1. Ensure the SCM input is visible and focused
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
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        // 3. Set the description
        // Use insertText for speed, but follow up with a validation
        await page.keyboard.insertText(description);

        // 4. Validate that all words appear in order inside the row (ignoring VS Code's weird whitespace concatenation).
        const words = description.trim().split(/\s+/).filter(Boolean);
        const regexPattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        await expect(scmInputRow).toHaveText(new RegExp(regexPattern), { timeout: 3000 });
    }, `Failed to set SCM description to "${description}" reliably`).toPass({ timeout: 10000 });
}

/**
 * Asserts that the SCM input row contains the expected description.
 * Handles VS Code's text wrapping/concatenation.
 */
export async function expectScmDescription(page: Page, expected: string | RegExp) {
    const scmInputRow = page.getByRole('treeitem', { name: 'Source Control Input' });
    if (expected instanceof RegExp) {
        await expect(scmInputRow).toHaveText(expected);
    } else {
        const words = expected.trim().split(/\s+/).filter(Boolean);
        const regexPattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        await expect(scmInputRow).toHaveText(new RegExp(regexPattern));
    }
}

/**
 * Locates an SCM tree item, optionally matching a parent group name.
 */
export async function getScmItemLocator(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
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

        for (let i = groupIdx + 1; i < allItems.length; i++) {
            const label = (await allItems[i].getAttribute('aria-label')) || '';
            const level = await allItems[i].getAttribute('aria-level');

            if (fileNamePattern.test(label)) {
                return allItems[i];
            }

            if (level === '1') {
                throw new Error(`File "${fileName}" not found in group "${groupName}"`);
            }
        }
        throw new Error(`File "${fileName}" not found in group "${groupName}"`);
    } else {
        return page.getByRole('treeitem', { name: fileName }).first();
    }
}

/**
 * Asserts that a file matching fileNamePattern is listed under an SCM group matching groupNamePattern.
 */
export async function expectFileInScmGroup(
    page: Page,
    groupNamePattern: RegExp | string,
    fileNamePattern: RegExp | string,
) {
    const locator = await getScmItemLocator(page, fileNamePattern, groupNamePattern);
    await expect(locator).toBeVisible();
}

/**
 * Clicks a button in the JJ Log title bar by its name.
 */
export async function clickLogTitleButton(page: Page, name: string) {
    const header = page.locator('.pane-header', { hasText: 'JJ Log' }).first();
    const button = header.getByRole('button', { name });
    await expect(button).toBeVisible({ timeout: 10000 });
    await button.click();
}

/**
 * Clicks a button within a notification toast.
 */
export async function clickNotificationButton(page: Page, actionLabel: string) {
    await expect(async () => {
        const toast = page.locator('.notifications-toasts .notification-toast');
        const button = toast.getByRole('button', { name: actionLabel });
        await expect(button).toBeVisible({ timeout: 2000 });
        await button.click();
    }, `Failed to click notification button "${actionLabel}"`).toPass({ timeout: 15000 });
}

/**
 * Waits for the VS Code QuickInput widget to be visible and returns the input locator.
 */
export async function waitForQuickInput(page: Page, timeout: number = 10000): Promise<Locator> {
    const quickInput = page.locator('.quick-input-widget').filter({ visible: true });
    const input = quickInput.locator('input.input');
    await expect(input).toBeVisible({ timeout });
    return input;
}

/**
 * Robustly presses a shortcut key to open the QuickInput widget, retrying if VS Code ignores the keypress.
 */
export async function openQuickInputWithShortcut(page: Page, shortcut: string): Promise<Locator> {
    const quickInput = page.locator('.quick-input-widget');
    const input = quickInput.locator('input.input');

    // Ensure any leftover quick input is closed first
    await expect(quickInput).not.toBeVisible({ timeout: 5000 });

    await expect(async () => {
        if (!(await input.isVisible())) {
            await page.keyboard.press(shortcut);
        }
        await waitForQuickInput(page, 200);
    }, `Failed to open quick input via shortcut "${shortcut}"`).toPass({ timeout: 20000 });
    return input;
}

export type LogPillKind = 'bookmark' | 'workspace' | 'tag' | 'remote-bookmark';

/**
 * Robustly waits for a bookmark or workspace pill to be visible in the JJ Log webview.
 * Handles webview reloads by re-fetching the frame on each retry.
 */
export async function waitForLogPill(page: Page, label: string, kind?: LogPillKind): Promise<Locator> {
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
    ).toPass({ timeout: 20000 });

    if (!pill) {
        throw new Error(`Failed to find log ${kind || 'pill'} with text "${label}"`);
    }
    return pill;
}

export type LogRowCriteria = string | RegExp | { changeId?: string; text?: string | RegExp };

/**
 * Robustly finds a commit row in the JJ Log webview by its text content or changeId attribute.
 * Handles webview reloads by re-fetching the frame on retry.
 */
export async function waitForLogCommitRow(page: Page, criteria: LogRowCriteria, repo?: TestRepo): Promise<Locator> {
    let row: Locator | undefined;
    try {
        await expect(
            async () => {
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
        ).toPass({ timeout: 20000 });
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
    return row;
}

/**
 * Robustly clicks an action button (like "Abandon", "Squash", etc.) on a commit row.
 * Re-fetches the frame and row on each retry to handle webview reloads.
 */
export async function clickLogAction(page: Page, rowCriteria: LogRowCriteria, actionTitle: string, repo?: TestRepo) {
    await expect(
        async () => {
            const row = await waitForLogCommitRow(page, rowCriteria, repo);
            await row.hover();

            const button = row.locator(`[title="${actionTitle}"]`);
            await expect(button).toBeVisible({ timeout: 200 });
            await button.click({ force: true });
        },
        `Failed to click action "${actionTitle}" on row matching ${JSON.stringify(rowCriteria)}`,
    ).toPass({
        timeout: 20000,
    });
}

/**
 * Verifies that the multi-file diff view lists exactly the expected modified files.
 */
export async function expectModifiedFiles(page: Page, expectedFiles: string[]) {
    await expect
        .poll(async () => {
            return await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('.file-path .title.modified .label-name'));
                return elements.map((el) => el.textContent?.trim()).filter(Boolean);
            });
        }, 'Wait for exactly modified files list in multi-diff')
        .toEqual(expectedFiles);
}

/**
 * Robustly opens a file via the File Explorer tree view.
 */
export async function openFileInEditor(page: Page, fileName: string): Promise<Locator> {
    const explorerPane = page.locator('#workbench\\.view\\.explorer');
    const fileRowInExplorer = page.getByRole('treeitem', { name: fileName }).first();
    const tab = page.getByRole('tab', { name: fileName, selected: true });

    await expect(async () => {
        // Ensure Explorer sidebar is open
        if (!(await explorerPane.isVisible())) {
            await page.keyboard.press('Control+Shift+E');
            await expect(explorerPane).toBeVisible({ timeout: 200 });
        }

        // If the file tab is already open and selected, we don't need to click anything
        if (await tab.isVisible()) {
            const editor = page.locator('.editor-group-container.active .monaco-editor').first();
            if (await editor.isVisible()) {
                return;
            }
        }

        await expect(fileRowInExplorer).toBeVisible({ timeout: 200 });
        await fileRowInExplorer.click();
        await expect(tab).toBeVisible({ timeout: 200 });

        const editor = page.locator('.editor-group-container.active .monaco-editor').first();
        await expect(editor).toBeVisible({ timeout: 200 });
    }, `Failed to open file "${fileName}" in editor`).toPass({ timeout: 7000 });

    return page.locator('.editor-group-container.active .monaco-editor').first();
}

/**
 * Robustly opens a file diff from the SCM pane by clicking its tree item.
 */
export async function openScmDiff(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
    return await openScmItem(page, fileName, '.monaco-diff-editor', groupName);
}

/**
 * Robustly opens a conflict merge editor from the SCM pane.
 */
export async function openScmMerge(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
    return await openScmItem(page, fileName, '.merge-editor', groupName);
}

/**
 * Robustly opens a file (regular editor) from the SCM pane by clicking its tree item.
 */
export async function openScmFile(
    page: Page,
    fileName: string | RegExp,
    groupName?: string | RegExp,
): Promise<Locator> {
    return await openScmItem(page, fileName, '.editor-instance .monaco-editor', groupName);
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
    return row;
}

/**
 * Finds the webview frame containing the Commit Details panel.
 * Re-fetches frames on poll to handle detached frames.
 */
export async function getDetailsWebview(page: Page): Promise<Frame> {
    const findFrame = async (frames: ReadonlyArray<Frame>): Promise<Frame | undefined> => {
        for (const f of frames) {
            try {
                // Return the first iframe that is actually visible (not hidden by VS Code's tab switching)
                // We consider it the active webview if its textarea is visible, meaning it's the actively displayed tab
                if (await f.locator('textarea').isVisible({ timeout: 50 })) {
                    return f;
                }

                const nested = await findFrame(f.childFrames());
                if (nested) {
                    return nested;
                }
            } catch (_e) {}
        }
        return undefined;
    };

    let guestFrame: Frame | undefined;
    await expect
        .poll(
            async () => {
                guestFrame = await findFrame(page.frames());
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
    return guestFrame;
}

export async function pickQuickPickItem(
    page: Page,
    label: string | RegExp,
    options?: { submitAsArbitraryText?: boolean },
) {
    await expect(async () => {
        const input = await waitForQuickInput(page);

        // If it's a string, type/fill it to filter the quick pick list
        if (typeof label === 'string') {
            await input.focus();
            await input.fill(label);
            await expect(input).toHaveValue(label);
        }

        const quickPick = page.locator('.quick-input-widget').filter({ visible: true });

        if (options?.submitAsArbitraryText) {
            // Wait for the list to filter down (no items should match the arbitrary text)
            const listRow = quickPick.locator('.monaco-list-row');
            await expect(listRow).toHaveCount(0, { timeout: 2000 });
            await input.press('Enter');
        } else {
            // Find the item by text within the quickpick list
            const item = quickPick.locator('.monaco-list-row').filter({ hasText: label }).first();
            await expect(item).toBeVisible({ timeout: 2000 });
            await item.click();
        }

        await expect(quickPick).not.toBeVisible({ timeout: 5000 });
    }, `Failed to pick QuickPick item "${label}"`).toPass({ timeout: 15000 });
}

/**
 * Selects an entire line of text in an editor by its content.
 */
export async function selectLine(page: Page, editor: Locator, text: string | RegExp): Promise<Locator> {
    const line = editor.getByText(text).first();
    await line.click();

    const cmdKey = isMac ? 'Meta' : 'Control';
    await page.keyboard.down(cmdKey);
    await page.keyboard.press('l');
    await page.keyboard.up(cmdKey);

    return line;
}

/**
 * Clicks an item in an open context menu.
 */
export async function clickContextMenuItem(page: Page, label: string | RegExp) {
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
}
/**
 * Saves the active editor using the platform-specific shortcut.
 */
export async function saveActiveEditor(page: Page) {
    await page.keyboard.press(isMac ? 'Meta+s' : 'Control+s');
}

/**
 * Clears all text in the active editor.
 */
export async function clearActiveEditor(page: Page) {
    await page.keyboard.press(isMac ? 'Meta+a' : 'Control+a');
    await page.keyboard.press('Backspace');
}

/**
 * Closes the active editor using the platform-specific shortcut.
 */
export async function closeActiveEditor(page: Page) {
    await page.keyboard.press(isMac ? 'Meta+w' : 'Control+w');
}

/**
 * Asserts that a badge link exists inside a commit row and points to the correct URL.
 */
export async function expectBadgeLink(row: Locator, hasText: string, expectedUrl: string) {
    const badgeLink = row.locator('a', { hasText });
    await expect(badgeLink).toBeVisible({
        timeout: 20000,
    });
    await expect(badgeLink).toHaveAttribute('href', expectedUrl);
}
