/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { _electron as electron, Page, type Frame, ElectronApplication } from 'playwright';
import { expect, Locator } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TestRepo } from '../test-repo';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

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
export async function launchVSCode(repo: TestRepo): Promise<VSCodeContext> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-user-data-'));
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-extensions-'));
    const userSettingsDir = path.join(userDataDir, 'User');
    fs.mkdirSync(userSettingsDir, { recursive: true });

    fs.writeFileSync(
        path.join(userSettingsDir, 'settings.json'),
        JSON.stringify(
            {
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
                'workbench.notification.displayMode': 'hidden',
                'notifications.showDoNotDisturb': true,
                'update.mode': 'none',
                'extensions.autoCheckUpdates': false,
                'extensions.autoUpdate': false,
                'explorer.excludeGitIgnore': false,
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
            ],
            null,
            2,
        ),
    );

    const extensionPath = path.resolve(__dirname, '../../../../');
    const vscodePath = await downloadAndUnzipVSCode();

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
        const { spawnSync } = await import('child_process');
        console.log(`Installing VSIX from ${vsixPath}...`);
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

    const app = await electron.launch({
        executablePath: vscodePath,
        args,
    });

    const page = await app.firstWindow();

    // Capture page console logs for debugging
    page.on('console', (msg) => {
        if (process.env.DEBUG_E2E) {
            console.log(`PAGE LOG: ${msg.text()}`);
        }
    });
    page.on('pageerror', (err) => console.error(`PAGE ERROR: ${err.message}`));

    // Wait for the workbench to be ready
    await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 15000 });

    // Hide notification toasts via CSS. Error-level toasts (e.g. "failed to load
    // extension") bypass VS Code's Do Not Disturb / displayMode settings and can
    // overlay buttons, causing click interception in tests.
    await page.addStyleTag({ content: '.notifications-toasts { display: none !important; }' });

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
 * Finds the webview frame containing the JJ Log commit rows.
 */
export async function getLogWebview(page: Page): Promise<Frame> {
    // The panel header
    await expect(page.locator('.pane-header', { hasText: 'JJ Log' })).toBeVisible({ timeout: 20000 });

    async function findFrameWithSelector(frames: ReadonlyArray<Frame>, selector: string): Promise<Frame | undefined> {
        for (const f of frames) {
            try {
                if ((await f.locator(selector).count()) > 0) return f;
                const nested = await findFrameWithSelector(f.childFrames(), selector);
                if (nested) return nested;
            } catch (e) {}
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
                timeout: 30000,
                message: 'Could not find JJ Log webview frame',
            },
        )
        .toBeDefined();

    return guestFrame!;
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
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        await row.click({
            modifiers: i > 0 ? ['Meta'] : undefined,
            force: true, // Bypasses potential hover overlay issues
        });
        await expect(row).toHaveAttribute('aria-selected', 'true', { timeout: 5000 });
    }
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
