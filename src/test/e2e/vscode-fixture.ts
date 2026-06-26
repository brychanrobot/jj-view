/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test as baseTest, expect } from '@playwright/test';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, SilentReporter } from '@vscode/test-electron';
import { type ElectronApplication, _electron as electron, type Page } from 'playwright';
import type * as vscodeType from 'vscode';
import type { Api as ExtensionApi } from '../../extension';
import { logPerf } from './perf-logger';

export const ROOT_ID = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
export const isMac = process.platform === 'darwin';

interface WorkspaceConfig {
    folders?: Array<{ path?: string }>;
}

function getWorkspaceFolderPaths(workspacePath: string): string[] {
    try {
        const content = fs.readFileSync(workspacePath, 'utf8');
        const config = JSON.parse(content) as WorkspaceConfig;
        if (!config || !Array.isArray(config.folders)) {
            return [];
        }
        return config.folders.map((f) => f.path).filter((p): p is string => typeof p === 'string');
    } catch (e) {
        console.error(`Failed to parse workspace config at ${workspacePath}:`, e);
        return [];
    }
}

function deleteWatchmanWatches(openedRepos: string[]): void {
    const watchPaths: string[] = [];
    for (const repoPath of openedRepos) {
        watchPaths.push(repoPath);
        if (repoPath.endsWith('.code-workspace')) {
            watchPaths.push(...getWorkspaceFolderPaths(repoPath));
        }
    }

    for (const p of watchPaths) {
        try {
            spawnSync('watchman', ['watch-del', p], { timeout: 1000 });
        } catch {}
    }
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
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
    'jj-view.autoRepositoryDetection': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'explorer.excludeGitIgnore': false,
    'files.hotExit': 'off',
};

export interface VSCodeContext {
    app: ElectronApplication;
    page: Page;
    userDataDir: string;
}

export interface VSCodeFixture {
    app?: ElectronApplication;
    page?: Page;
    userDataDir: string;
    openWorkspace(
        repo: { path: string },
        extraSettings?: Record<string, unknown>,
        extraEnv?: Record<string, string | undefined>,
        showNotifications?: boolean,
        skipRepoSync?: boolean,
    ): Promise<VSCodeContext>;
    evaluate<T>(
        fn: (vscode: typeof vscodeType, api: ExtensionApi, ...args: unknown[]) => Promise<T> | T,
        ...args: unknown[]
    ): Promise<T>;
    evaluateHandle(
        fn: (vscode: typeof vscodeType, api: ExtensionApi, ...args: unknown[]) => unknown,
        ...args: unknown[]
    ): Promise<{ __vscode_handle__: string }>;
    releaseHandle(handle: { __vscode_handle__: string }): Promise<void>;
    closeAllEditors(): Promise<void>;
    clearRepositoryManager(): Promise<void>;
    executeCommand<T>(command: string, ...args: unknown[]): Promise<T>;
    executeCommandWithSaveDialog(
        command: string,
        action: 'Save' | "Don't Save" | 'Cancel',
        ...args: unknown[]
    ): Promise<void>;

    openFolder(folderPath: string): Promise<void>;
    openFileInEditor(absolutePath: string): Promise<void>;
    getOutputChannelLogs(channelName?: string): Promise<string>;
}

export function getIpcPath(userDataDir: string): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\jj-view-test-${path.basename(userDataDir)}`
        : path.join(userDataDir, 'test-ipc.sock');
}

export async function sendEvaluation(
    userDataDir: string,
    action: 'evaluate' | 'evaluateHandle' | 'releaseHandle' | 'shutdown',
    fn?: ((...args: never[]) => unknown) | string,
    args: unknown[] = [],
    handleId?: string,
): Promise<Record<string, unknown>> {
    const ipcPath = getIpcPath(userDataDir);
    const scriptStr = fn ? fn.toString() : undefined;
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                socketPath: ipcPath,
                method: 'POST',
                path: '/command',
                headers: { 'Content-Type': 'application/json' },
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed.status === 'error') {
                            reject(new Error(`Error in VS Code evaluation: ${parsed.error}`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (err) {
                        reject(new Error(`Failed to parse response: ${body}. Error: ${err}`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.write(JSON.stringify({ action, script: scriptStr, args, handleId }));
        req.end();
    });
}

// Wait for the HTTP-over-IPC socket to be ready
export async function awaitIpcReady(userDataDir: string, timeout = 15000): Promise<void> {
    const ipcPath = getIpcPath(userDataDir);
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < timeout) {
        attempts++;
        if (process.platform !== 'win32' && !fs.existsSync(ipcPath)) {
            await new Promise((r) => setTimeout(r, 100));
            continue;
        }

        try {
            const res = await sendEvaluation(
                userDataDir,
                'evaluate',
                async (_vscode: typeof vscodeType, _api: ExtensionApi) => {
                    return 'success';
                },
            );
            if (res && res.result === 'success') {
                logPerf('awaitIpcReady', start, /* prefix= */ undefined, `(attempts: ${attempts})`);
                return;
            }
        } catch {
            // Not ready yet
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for IPC socket at ${ipcPath} to be ready.`);
}

export async function launchNewVSCode(
    workspacePath: string,
    extraSettings: Record<string, unknown> = {},
    extraEnv: Record<string, string | undefined> = {},
    showNotifications = false,
    userDataDir?: string,
): Promise<VSCodeContext> {
    const totalStart = Date.now();
    const finalUserDataDir =
        userDataDir ?? (await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jj-view-test-user-data-')));
    const userSettingsDir = path.join(finalUserDataDir, 'User');

    const settingsContent = JSON.stringify(
        {
            ...DEFAULT_SETTINGS,
            'workbench.notification.displayMode': showNotifications ? 'default' : 'hidden',
            'notifications.showDoNotDisturb': !showNotifications,
            ...extraSettings,
        },
        null,
        2,
    );

    const keybindingsContent = JSON.stringify(
        [
            { key: 'ctrl+alt+l', command: 'jj-view.logView.focus' },
            { key: 'ctrl+alt+r', command: 'jj-view.refresh' },
            { key: 'ctrl+alt+e', command: 'workbench.files.action.refreshFilesExplorer' },
            { key: 'ctrl+alt+c', command: 'jj-view.compareWithWorkingCopy' },
            { key: 'ctrl+alt+f', command: 'jj-view.compareFileWith' },
            { key: 'ctrl+alt+d', command: 'jj-view.deleteBookmark' },
        ],
        null,
        2,
    );

    const writeConfigsStart = Date.now();
    const writeConfigs = async () => {
        await fs.promises.mkdir(userSettingsDir, { recursive: true });
        await Promise.all([
            fs.promises.writeFile(path.join(userSettingsDir, 'settings.json'), settingsContent),
            fs.promises.writeFile(path.join(userSettingsDir, 'keybindings.json'), keybindingsContent),
        ]);
        logPerf('launchNewVSCode: writeConfigs', writeConfigsStart);
    };

    const extensionPath = path.resolve(__dirname, '../../../');

    const downloadStart = Date.now();
    const [extensionsDir, vscodePath] = await Promise.all([
        fs.promises.mkdtemp(path.join(os.tmpdir(), 'jj-view-test-extensions-')),
        downloadAndUnzipVSCode({ reporter: new SilentReporter() }).then((res) => {
            logPerf('launchNewVSCode: downloadAndUnzipVSCode', downloadStart);
            return res;
        }),
        writeConfigs(),
    ]);

    const args = [
        workspacePath,
        `--user-data-dir=${finalUserDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        `--extensionDevelopmentPath=${extensionPath}`,
        `--extensionDevelopmentPath=${path.join(extensionPath, 'src/test/e2e/helper-extension')}`,
        '--extension-development-confirm-save',
        '--disable-workspace-trust',
        '--new-window',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-updates',
        '--password-store=basic',

        // --- THESE PREVENT WINDOW FOCUS AND WINDOW VISIBILITY ---
        '--headless=new',
        '--no-startup-window',
    ];

    if (process.env.VSIX_PATH) {
        const vsixPath = path.resolve(process.env.VSIX_PATH);
        if (!fs.existsSync(vsixPath)) {
            throw new Error(`VSIX_PATH is set but file does not exist: ${vsixPath}`);
        }
        const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodePath);
        console.log(`Installing VSIX from ${vsixPath} using CLI ${cliPath}...`);
        const vsixInstallStart = Date.now();
        const result = spawnSync(cliPath, ['--install-extension', vsixPath, '--extensions-dir', extensionsDir], {
            encoding: 'utf-8',
            stdio: 'inherit',
        });
        logPerf('launchNewVSCode: install VSIX', vsixInstallStart);

        if (result.status !== 0) {
            throw new Error(`Failed to install extension VSIX: ${result.stderr || result.error}`);
        }
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

    let launched: { app: ElectronApplication; page: Page } | undefined;
    const launchStart = Date.now();
    await expect(async () => {
        const appLaunchStart = Date.now();
        const app = await electron.launch({
            executablePath: vscodePath,
            args,
            env,
        });
        logPerf('launchNewVSCode: electron.launch', appLaunchStart);

        try {
            const firstWindowStart = Date.now();
            const page = await app.firstWindow({ timeout: 2000 });
            logPerf('launchNewVSCode: app.firstWindow', firstWindowStart);
            const proc = app.process();
            proc.stdout?.on('data', (data) => console.log(`[VSCode Stdout] ${data.toString().trim()}`));
            proc.stderr?.on('data', (data) => console.error(`[VSCode Stderr] ${data.toString().trim()}`));
            launched = { app, page };
        } catch (err) {
            await app.close();
            throw err;
        }
    }).toPass({ timeout: 7000 });
    logPerf('launchNewVSCode: electron launch wrapper', launchStart);

    if (!launched) {
        throw new Error('Failed to launch VS Code app or obtain its first window');
    }

    if (process.env.VERBOSE) {
        launched.page.on('console', (msg) => {
            console.log(`PAGE LOG: ${msg.text()}`);
        });
        launched.page.on('pageerror', (err) => console.error(`PAGE ERROR: ${err.message}`));
    }

    const workbenchVisibleStart = Date.now();
    await expect(launched.page.locator('.monaco-workbench')).toBeVisible({ timeout: 15000 });
    logPerf('launchNewVSCode: monaco-workbench visibility', workbenchVisibleStart);

    await launched.page.addStyleTag({
        content: 'body:not(.show-notifications) .notifications-toasts { display: none !important; }',
    });
    await launched.page.evaluate((show) => {
        document.body.classList.toggle('show-notifications', show);
    }, showNotifications);

    logPerf('launchNewVSCode: total', totalStart);
    return { ...launched, userDataDir: finalUserDataDir };
}

export async function closeApp(context: VSCodeContext) {
    let closed = false;
    const closePromise = context.app.close().then(() => {
        closed = true;
    });

    try {
        while (!closed) {
            try {
                const windows = context.app.windows();
                for (const win of windows) {
                    if (win.isClosed()) {
                        continue;
                    }
                    const dialog = win.locator('.monaco-dialog-box').filter({ visible: true }).first();
                    if (await dialog.isVisible()) {
                        const dontSave = dialog.getByRole('button', { name: /don['’]t save/i }).first();
                        if (await dontSave.isVisible()) {
                            await dontSave.click();
                        } else {
                            const closeWithConflicts = dialog.getByRole('button', { name: /close.*conflict/i }).first();
                            if (await closeWithConflicts.isVisible()) {
                                await closeWithConflicts.click();
                            }
                        }
                    }
                }
            } catch {
                // ignore
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    } catch {
        // ignore
    }
    await closePromise;
}

type SharedWorkerContext = VSCodeContext & {
    extraEnv: Record<string, string | undefined>;
    extraSettings: Record<string, unknown>;
    showNotifications: boolean;
    needsReset?: boolean;
};

const originalEnv = { ...process.env };
let globalActiveContext: SharedWorkerContext | undefined;

function cleanupSharedVSCode() {
    if (globalActiveContext) {
        try {
            sendEvaluation(globalActiveContext.userDataDir, 'shutdown').catch(() => {});
        } catch {}
        try {
            globalActiveContext.app.close().catch(() => {});
        } catch {}
        try {
            fs.rmSync(globalActiveContext.userDataDir, { recursive: true, force: true });
        } catch {}
        globalActiveContext = undefined;
    }
}

process.once('exit', cleanupSharedVSCode);
process.once('SIGINT', () => {
    cleanupSharedVSCode();
    process.exit(130);
});
process.once('SIGTERM', () => {
    cleanupSharedVSCode();
    process.exit(143);
});

export class VSCodeWorker {
    async init(): Promise<void> {
        if (globalActiveContext) {
            return;
        }
        const totalStart = Date.now();
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-user-data-'));
        const emptyFolderDir = path.join(userDataDir, 'empty');
        fs.mkdirSync(emptyFolderDir, { recursive: true });

        const workspacePath = path.join(userDataDir, 'test.code-workspace');
        const foldersData = [{ path: emptyFolderDir }];
        const workspaceData = { folders: foldersData };
        fs.writeFileSync(workspacePath, JSON.stringify(workspaceData, null, 2));

        const ipcPath = getIpcPath(userDataDir);
        const env = {
            JJ_TEST_IPC_PATH: ipcPath,
        };

        const launched = await launchNewVSCode(workspacePath, {}, env, false, userDataDir);
        await awaitIpcReady(userDataDir);

        globalActiveContext = {
            ...launched,
            extraEnv: {},
            extraSettings: {},
            showNotifications: false,
        };
        logPerf('VSCodeWorker.init() finished', totalStart);
    }

    async getContext(
        repo: { path: string },
        extraSettings: Record<string, unknown>,
        extraEnv: Record<string, string | undefined>,
        showNotifications: boolean,
    ): Promise<VSCodeContext> {
        const totalGetContextStart = Date.now();
        let isAlive = false;
        if (globalActiveContext) {
            try {
                isAlive = !globalActiveContext.page.isClosed() && !globalActiveContext.needsReset;
            } catch {
                isAlive = false;
            }
        }

        if (globalActiveContext && isAlive) {
            try {
                const res = await this.reuseContext(
                    globalActiveContext,
                    repo,
                    extraSettings,
                    extraEnv,
                    showNotifications,
                );
                logPerf('getContext (reused)', totalGetContextStart);
                return res;
            } catch (err) {
                console.error('Failed to reuse context, forcing new launch:', err);
                if (globalActiveContext) {
                    globalActiveContext.needsReset = true;
                }
                isAlive = false;
            }
        }

        if (globalActiveContext) {
            const cleanupStart = Date.now();
            await closeApp(globalActiveContext);
            try {
                fs.rmSync(globalActiveContext.userDataDir, { recursive: true, force: true });
            } catch {}
            globalActiveContext = undefined;
            logPerf('getContext: cleaning up old context', cleanupStart);
        }

        const setupDirsStart = Date.now();
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-user-data-'));

        const emptyFolderDir = path.join(userDataDir, 'empty');
        fs.mkdirSync(emptyFolderDir, { recursive: true });

        const workspacePath = path.join(userDataDir, 'test.code-workspace');
        const foldersData: Array<{ path: string }> = [{ path: emptyFolderDir }];
        if (repo.path.endsWith('.code-workspace')) {
            const paths = getWorkspaceFolderPaths(repo.path);
            for (const p of paths) {
                foldersData.push({ path: p });
            }
        } else {
            foldersData.push({ path: repo.path });
        }
        const workspaceData = {
            folders: foldersData,
        };
        fs.writeFileSync(workspacePath, JSON.stringify(workspaceData, null, 2));
        logPerf('getContext: setupDirs', setupDirsStart);

        const ipcPath = getIpcPath(userDataDir);

        const env = {
            ...extraEnv,
            JJ_TEST_IPC_PATH: ipcPath,
        };

        const launchStart = Date.now();
        const launched = await launchNewVSCode(workspacePath, extraSettings, env, showNotifications, userDataDir);
        logPerf('getContext: launchNewVSCode', launchStart);

        const ipcReadyStart = Date.now();
        await awaitIpcReady(userDataDir);
        logPerf('getContext: awaitIpcReady', ipcReadyStart);

        globalActiveContext = {
            ...launched,
            extraEnv,
            extraSettings,
            showNotifications,
        };

        logPerf('getContext (new launch)', totalGetContextStart);
        return globalActiveContext;
    }

    private async reuseContext(
        context: SharedWorkerContext,
        repo: { path: string },
        extraSettings: Record<string, unknown>,
        extraEnv: Record<string, string | undefined>,
        showNotifications: boolean,
    ): Promise<VSCodeContext> {
        // 1. Update the settings first (under the new context/notifications config)
        const startSettings = Date.now();
        await this.updateSettings(context, extraSettings, showNotifications);
        logPerf('reuseContext updateSettings', startSettings);

        // 2. Update the environment variables dynamically
        const startEnv = Date.now();
        await this.updateEnvironment(context, extraEnv);
        logPerf('reuseContext updateEnvironment', startEnv);

        // 3. Update workspace folders to the new repo path
        const startWorkspace = Date.now();
        try {
            await this.updateWorkspaceFolders(context, repo);
        } catch (_err) {
            console.error('[DEBUG] updateWorkspaceFolders failed:', _err);
        }
        logPerf('reuseContext updateWorkspaceFolders', startWorkspace);

        // 4. Trigger repository scan after settings and environment have been updated
        const startScan = Date.now();
        await sendEvaluation(context.userDataDir, 'evaluate', async (_vscode: typeof vscodeType, api: ExtensionApi) => {
            await api.repositoryManager.scanForRepositories();
        });
        logPerf('reuseContext scanForRepositories', startScan);

        await context.page.addStyleTag({
            content: 'body:not(.show-notifications) .notifications-toasts { display: none !important; }',
        });
        await context.page.evaluate((show) => {
            document.body.classList.toggle('show-notifications', show);
        }, showNotifications);

        context.extraSettings = extraSettings;
        context.extraEnv = extraEnv;
        context.showNotifications = showNotifications;

        return context;
    }

    private async updateEnvironment(
        context: SharedWorkerContext,
        newExtraEnv: Record<string, string | undefined>,
    ): Promise<void> {
        const envUpdates: Record<string, string | null> = {};

        // For any key that was in the previous extraEnv but is NOT in the new extraEnv,
        // restore its original value or delete it.
        for (const key of Object.keys(context.extraEnv)) {
            if (!(key in newExtraEnv)) {
                const originalVal = originalEnv[key];
                envUpdates[key] = originalVal !== undefined ? originalVal : null;
            }
        }

        // For any key in the new extraEnv, set it.
        for (const key of Object.keys(newExtraEnv)) {
            const val = newExtraEnv[key];
            envUpdates[key] = val !== undefined ? val : null;
        }

        if (Object.keys(envUpdates).length > 0) {
            await sendEvaluation(
                context.userDataDir,
                'evaluate',
                async (_vscode: typeof vscodeType, _api: ExtensionApi, updates: unknown) => {
                    const envUpdates = updates as Record<string, string | null>;
                    for (const key of Object.keys(envUpdates)) {
                        const val = envUpdates[key];
                        if (val === null) {
                            delete process.env[key];
                        } else {
                            process.env[key] = val;
                        }
                    }
                },
                [envUpdates],
            );
        }
    }

    async cleanup(): Promise<void> {
        // No-op: We preserve the VS Code instance across sequential spec files run by this worker process.
        // The process-level exit handlers will clean up the application and user data directory.
    }

    private async updateWorkspaceFolders(context: VSCodeContext, repo: { path: string }): Promise<void> {
        const start = Date.now();
        let evaluateDone = false;
        const folderPaths: string[] = [];
        if (repo.path.endsWith('.code-workspace')) {
            folderPaths.push(...getWorkspaceFolderPaths(repo.path));
        } else {
            folderPaths.push(repo.path);
        }

        const evaluatePromise = sendEvaluation(
            context.userDataDir,
            'evaluate',
            async (vscode: typeof vscodeType, _api: ExtensionApi, paths: unknown) => {
                const evalStart = Date.now();
                if (!Array.isArray(paths)) {
                    throw new Error('paths must be an array');
                }
                const targetPaths = paths as string[];
                const uris = targetPaths.map((p) => vscode.Uri.file(p));
                const workspaceFolders = vscode.workspace.workspaceFolders || [];
                const deleteCount = workspaceFolders.length > 1 ? workspaceFolders.length - 1 : 0;
                vscode.workspace.updateWorkspaceFolders(1, deleteCount, ...uris.map((uri) => ({ uri })));

                // Wait for all the workspace folders to be fully registered by the Extension Host
                // before proceeding, otherwise settings overrides may not apply correctly.
                await globalThis.waitUntil(() => uris.every((uri) => vscode.workspace.getWorkspaceFolder(uri)));
                globalThis.logPerf('updateWorkspaceFolders (eval) found folders', evalStart);
            },
            [folderPaths],
        ).then((r) => {
            evaluateDone = true;
            return r;
        });
        evaluatePromise.catch(() => {});

        // Fallback timeout in case evaluate hangs due to dialogs
        await Promise.race([evaluatePromise, new Promise((resolve) => setTimeout(resolve, 5000))]);
        logPerf('updateWorkspaceFolders: evaluate', start);
        if (!evaluateDone) {
            // If it timed out, try to dismiss any blocking dialogs and wait a bit more
            if (context.page) {
                try {
                    const dialog = context.page.locator('.monaco-dialog-box').filter({ visible: true }).first();
                    await dialog.waitFor({ state: 'visible', timeout: 500 });

                    const dontSave = dialog.getByRole('button', { name: /don['’]t save/i }).first();
                    if (await dontSave.isVisible()) {
                        await dontSave.click();
                    }

                    const closeWithConflicts = dialog.getByRole('button', { name: /close.*conflict/i }).first();
                    if (await closeWithConflicts.isVisible()) {
                        await closeWithConflicts.click();
                    }
                } catch {}
            }
            await Promise.race([evaluatePromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
        }
        if (!evaluateDone) {
            throw new Error('updateWorkspaceFolders timed out');
        }
    }

    private async updateSettings(
        context: SharedWorkerContext,
        extraSettings: Record<string, unknown>,
        showNotifications: boolean,
    ): Promise<void> {
        const start = Date.now();

        const settingsToUpdate: Record<string, unknown> = {
            'workbench.notification.displayMode': showNotifications ? 'default' : 'hidden',
            'notifications.showDoNotDisturb': !showNotifications,
            'window.dialogStyle': 'custom',
            ...extraSettings,
        };

        for (const key in context.extraSettings) {
            if (!(key in extraSettings)) {
                settingsToUpdate[key] = null;
            }
        }

        try {
            await sendEvaluation(
                context.userDataDir,
                'evaluate',
                async (
                    vscode: typeof vscodeType,
                    _api: ExtensionApi,
                    settingsVal: unknown,
                    defaultSettingsVal: unknown,
                ) => {
                    const evalStart = Date.now();
                    const settings = settingsVal as Record<string, unknown>;
                    const defaultSettings = defaultSettingsVal as Record<string, unknown>;

                    // Validate that all extension-specific settings are registered in package.json
                    const extension = vscode.extensions.all.find(
                        (e) => e.id.endsWith('.jj-view') || e.id === 'jj-view',
                    );
                    const properties = extension?.packageJSON?.contributes?.configuration?.properties || {};
                    const registered = new Set(Object.keys(properties));

                    for (const key of Object.keys(settings)) {
                        if (key.startsWith('jj-view.') && !registered.has(key)) {
                            throw new Error(
                                `Attempted to set configuration setting "${key}" which is not registered in package.json. ` +
                                    `Please register it in contributes.configuration.properties or check the spelling.`,
                            );
                        }
                    }

                    const promises: Promise<void>[] = [];

                    // Reset all registered extension settings to prevent bleed/leak between tests
                    // Restore them to the initial test suite defaults from DEFAULT_SETTINGS if specified.
                    for (const key of registered) {
                        if (key in settings) {
                            continue;
                        }
                        const dotIdx = key.indexOf('.');
                        const defaultVal = defaultSettings[key];
                        try {
                            if (dotIdx !== -1) {
                                const section = key.substring(0, dotIdx);
                                const childKey = key.substring(dotIdx + 1);
                                const config = vscode.workspace.getConfiguration(section);
                                const inspect = config.inspect(childKey);
                                if (inspect?.workspaceValue !== undefined) {
                                    promises.push(
                                        Promise.resolve(
                                            config.update(childKey, undefined, vscode.ConfigurationTarget.Workspace),
                                        ),
                                    );
                                }
                                if (inspect?.globalValue !== defaultVal) {
                                    promises.push(
                                        Promise.resolve(
                                            config.update(childKey, defaultVal, vscode.ConfigurationTarget.Global),
                                        ),
                                    );
                                }
                            } else {
                                const config = vscode.workspace.getConfiguration();
                                const inspect = config.inspect(key);
                                if (inspect?.workspaceValue !== undefined) {
                                    promises.push(
                                        Promise.resolve(
                                            config.update(key, undefined, vscode.ConfigurationTarget.Workspace),
                                        ),
                                    );
                                }
                                if (inspect?.globalValue !== defaultVal) {
                                    promises.push(
                                        Promise.resolve(
                                            config.update(key, defaultVal, vscode.ConfigurationTarget.Global),
                                        ),
                                    );
                                }
                            }
                        } catch {}
                    }

                    const failedSettings = new Set<string>();
                    for (const key of Object.keys(settings)) {
                        const val = settings[key] === null ? undefined : settings[key];
                        const dotIdx = key.indexOf('.');
                        try {
                            if (dotIdx !== -1) {
                                const section = key.substring(0, dotIdx);
                                const childKey = key.substring(dotIdx + 1);
                                const config = vscode.workspace.getConfiguration(section);
                                if (config.inspect(childKey)?.globalValue !== val) {
                                    promises.push(
                                        Promise.resolve(
                                            config.update(childKey, val, vscode.ConfigurationTarget.Global),
                                        ).catch(() => {
                                            failedSettings.add(key);
                                        }),
                                    );
                                }
                            } else {
                                const config = vscode.workspace.getConfiguration();
                                if (config.inspect(key)?.globalValue !== val) {
                                    promises.push(
                                        Promise.resolve(
                                            config.update(key, val, vscode.ConfigurationTarget.Global),
                                        ).catch(() => {
                                            failedSettings.add(key);
                                        }),
                                    );
                                }
                            }
                        } catch (_e) {
                            failedSettings.add(key);
                        }
                    }

                    if (promises.length > 0) {
                        await Promise.all(promises);
                    }

                    globalThis.logPerf(
                        'updateSettings (eval): update configurations',
                        evalStart,
                        /* prefix= */ undefined,
                        `(failed: ${Array.from(failedSettings).join(', ')})`,
                    );

                    // Poll until all settings have been successfully propagated
                    const startPoll = Date.now();
                    await globalThis.waitUntil(() => {
                        let allMatch = true;
                        for (const key of Object.keys(settings)) {
                            if (failedSettings.has(key)) {
                                continue;
                            }
                            let currentVal: unknown;
                            let isOverridden = false;
                            const dotIdx = key.indexOf('.');
                            if (dotIdx !== -1) {
                                const section = key.substring(0, dotIdx);
                                const childKey = key.substring(dotIdx + 1);
                                const config = vscode.workspace.getConfiguration(section);
                                currentVal = config.get(childKey);
                                isOverridden = config.inspect(childKey)?.workspaceValue !== undefined;
                            } else {
                                const config = vscode.workspace.getConfiguration();
                                currentVal = config.get(key);
                                isOverridden = config.inspect(key)?.workspaceValue !== undefined;
                            }
                            console.log(
                                `[DEBUG_SETTINGS] key=${key} expected=${settings[key]} current=${currentVal} isOverridden=${isOverridden}`,
                            );
                            const expectedVal: unknown = settings[key] === null ? undefined : settings[key];
                            if (expectedVal === undefined) {
                                if (isOverridden) {
                                    allMatch = false;
                                    break;
                                }
                            } else if (JSON.stringify(currentVal) !== JSON.stringify(expectedVal)) {
                                allMatch = false;
                                break;
                            }
                        }
                        return allMatch;
                    }, 5000);
                    globalThis.logPerf('Settings propagation', startPoll);
                    return 'success';
                },
                [settingsToUpdate, DEFAULT_SETTINGS],
            );
            logPerf('updateSettings: sendEvaluation', start);
        } catch (err) {
            console.error('Failed to update settings:', err);
            throw err;
        }
    }
}

export class VSCodeFixtureImpl implements VSCodeFixture {
    app?: ElectronApplication;
    page?: Page;
    userDataDir = '';
    private activeContext: VSCodeContext | undefined;
    private openedRepos: string[] = [];

    constructor(private readonly worker: VSCodeWorker) {}

    async openWorkspace(
        repo: { path: string },
        extraSettings: Record<string, unknown> = {},
        extraEnv: Record<string, string | undefined> = {},
        showNotifications = false,
        skipRepoSync = false,
    ): Promise<VSCodeContext> {
        const start = Date.now();
        this.openedRepos.push(repo.path);
        this.activeContext = await this.worker.getContext(repo, extraSettings, extraEnv, showNotifications);
        logPerf('openWorkspace: worker.getContext', start);
        this.app = this.activeContext.app;
        this.page = this.activeContext.page;
        this.userDataDir = this.activeContext.userDataDir;

        // Dismiss any active hovers, quick picks, or context menus from previous tests
        // before we do any operations for the new workspace
        const dismissStart = Date.now();
        if (this.page) {
            await this.page.mouse.move(0, 0);
            await this.page.keyboard.press('Escape');
        }
        logPerf('openWorkspace: dismiss UI', dismissStart);

        if (skipRepoSync) {
            logPerf('openWorkspace: total', start);
            return this.activeContext;
        }

        // Ensure that the repository manager has scanned, focused, and fully refreshed the target repository
        const repoSyncStart = Date.now();
        const syncDetails = (await this.evaluate(async (vscode, api, targetPath) => {
            const start = Date.now();
            let focusedFoundStart = 0;
            while (Date.now() - start < 15000) {
                const focused = api.repositoryManager.focusedRepository;
                if (typeof targetPath === 'string') {
                    const isMatch =
                        focused &&
                        (focused.rootUri.fsPath === targetPath ||
                            (targetPath.endsWith('.code-workspace') &&
                                (vscode.workspace.workspaceFolders || []).some(
                                    (f) => f.uri.fsPath === focused.rootUri.fsPath,
                                )));
                    if (isMatch) {
                        try {
                            if (!focusedFoundStart) {
                                focusedFoundStart = Date.now();
                            }
                            const refreshStart = Date.now();
                            if (focused.activeRefresh) {
                                await focused.activeRefresh;
                            } else {
                                await focused.refresh({ forceSnapshot: false, reason: 'e2e-sync' });
                            }
                            const refreshDuration = Date.now() - refreshStart;

                            const watchersStart = Date.now();
                            try {
                                // Ensure change detection watchers are fully registered and active
                                await focused.awaitWatchersReady();
                            } catch {}
                            const watchersDuration = Date.now() - watchersStart;

                            return {
                                status: 'success',
                                refreshDuration,
                                watchersDuration,
                                totalLoopTime: Date.now() - start,
                                findRepoDuration: focusedFoundStart - start,
                            };
                        } catch (e: unknown) {
                            const err = e as { message?: string; code?: string };
                            const msg = String(err?.message || e);
                            // If it's a "missing binary" error, we can safely ignore it because
                            // some tests specifically test invalid configurations.
                            if (
                                err?.code === 'ENOENT' ||
                                msg.includes('ENOENT') ||
                                msg.includes('executable was not found')
                            ) {
                                return {
                                    status: 'success',
                                    refreshDuration: 0,
                                    watchersDuration: 0,
                                    totalLoopTime: Date.now() - start,
                                    findRepoDuration: focusedFoundStart ? focusedFoundStart - start : 0,
                                };
                            }
                            // Otherwise, it might be a lock error. Let it loop and retry.
                        }
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`Timeout waiting for repository at ${targetPath} to be focused and refreshed.`);
        }, repo.path)) as {
            status: string;
            refreshDuration: number;
            watchersDuration: number;
            totalLoopTime: number;
            findRepoDuration: number;
        };

        logPerf(
            'openWorkspace: repository sync evaluate',
            repoSyncStart,
            /* prefix= */ undefined,
            `(loop: ${syncDetails.totalLoopTime}ms, findRepo: ${syncDetails.findRepoDuration}ms, refresh: ${syncDetails.refreshDuration}ms, watchers: ${syncDetails.watchersDuration}ms)`,
        );

        logPerf('openWorkspace: total', start);
        return this.activeContext;
    }

    async cleanupAfterTest() {
        const start = Date.now();
        if (this.activeContext) {
            try {
                const windows = this.activeContext.app.windows();
                for (const win of windows) {
                    if (win !== this.activeContext.page && !win.isClosed()) {
                        // Start closing the window asynchronously
                        const closePromise = win.close();

                        // Watch for and handle dialogs on the auxiliary window
                        try {
                            const dialog = win.locator('.monaco-dialog-box').filter({ visible: true }).first();
                            const dialogStart = Date.now();
                            while (Date.now() - dialogStart < 1500) {
                                if (win.isClosed()) {
                                    break;
                                }
                                if (await dialog.isVisible()) {
                                    const dontSave = dialog.getByRole('button', { name: /don['’]t save/i }).first();
                                    if (await dontSave.isVisible()) {
                                        await dontSave.click();
                                    }
                                }
                                await new Promise((resolve) => setTimeout(resolve, 50));
                            }
                        } catch {}

                        // Await completion or timeout
                        await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 1000))]).catch(
                            () => {},
                        );
                    }
                }
            } catch {
                // Ignore errors closing auxiliary windows
            }
            logPerf('cleanupAfterTest: close auxiliary windows', start);

            const cleanupEvalStart = Date.now();
            try {
                let evaluateDone = false;
                // We fire this off asynchronously because if it prompts, it will block the promise.
                const evaluatePromise = this.evaluate(async (vscode, api) => {
                    const evalStart = Date.now();

                    const hasOpenEditors = vscode.window.tabGroups.all.some((group) => group.tabs.length > 0);
                    if (hasOpenEditors) {
                        try {
                            await vscode.commands.executeCommand('workbench.action.closeAllEditors', {
                                skipConfirm: true,
                            });
                            globalThis.logPerf('cleanupAfterTest (eval): closeAllEditors', evalStart);
                        } catch {}
                    }

                    const clearStart = Date.now();
                    try {
                        await api.repositoryManager.clear();
                        globalThis.logPerf('cleanupAfterTest (eval): repoManager clear', clearStart);
                    } catch {}

                    const workspaceFolders = vscode.workspace.workspaceFolders || [];
                    if (workspaceFolders.length > 1) {
                        const workspaceFolderResetStart = Date.now();
                        try {
                            vscode.workspace.updateWorkspaceFolders(1, workspaceFolders.length - 1);
                            globalThis.logPerf('cleanupAfterTest (eval): workspace reset', workspaceFolderResetStart);
                            // Wait a short moment for folder updates and scanners to settle
                            await new Promise((resolve) => setTimeout(resolve, 50));
                        } catch {}
                    }
                }).catch(() => {});
                evaluatePromise.finally(() => {
                    evaluateDone = true;
                });

                if (this.page) {
                    try {
                        const dialog = this.page.locator('.monaco-dialog-box').filter({ visible: true }).first();
                        let lastLogTime = 0;
                        const loopStart = Date.now();
                        // Loop until the evaluatePromise finishes
                        // This handles multiple dialogs if multiple files/workspace are dirty
                        while (!evaluateDone && Date.now() - loopStart < 5000) {
                            try {
                                if (this.page.isClosed()) {
                                    break;
                                }
                                if (evaluateDone) {
                                    break;
                                }
                                if (await dialog.isVisible()) {
                                    const dontSave = dialog.getByRole('button', { name: /don['’]t save/i }).first();
                                    const closeWithConflicts = dialog
                                        .getByRole('button', { name: /close.*conflict/i })
                                        .first();

                                    if (await dontSave.isVisible()) {
                                        await dontSave.click();
                                        await new Promise((resolve) => setTimeout(resolve, 10));
                                    } else if (await closeWithConflicts.isVisible()) {
                                        await closeWithConflicts.click();
                                        await new Promise((resolve) => setTimeout(resolve, 10));
                                    } else {
                                        const now = Date.now();
                                        if (now - lastLogTime > 2000) {
                                            lastLogTime = now;
                                            const buttons = dialog.getByRole('button');
                                            const count = await buttons.count();
                                            const buttonTexts: string[] = [];
                                            for (let i = 0; i < count; i++) {
                                                buttonTexts.push((await buttons.nth(i).innerText()) || '');
                                            }
                                            console.log(
                                                `[DEBUG_DIALOG] Dialog is visible but no matching button found. ` +
                                                    `Buttons: ${JSON.stringify(buttonTexts)}`,
                                            );
                                        }
                                        await new Promise((resolve) => setTimeout(resolve, 10));
                                    }
                                } else {
                                    if (evaluateDone) {
                                        break;
                                    }
                                    await new Promise((resolve) => setTimeout(resolve, 5));
                                }
                            } catch {
                                if (evaluateDone) {
                                    break;
                                }
                                await new Promise((resolve) => setTimeout(resolve, 5));
                            }
                        }
                    } catch {
                        // Ignore errors finding/clicking the dialog
                    }
                }

                let timeoutId: NodeJS.Timeout | undefined;
                const timeoutPromise = new Promise<void>((resolve) => {
                    timeoutId = setTimeout(resolve, 5000);
                });
                await Promise.race([evaluatePromise, timeoutPromise]);
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                if (!evaluateDone) {
                    if (globalActiveContext) {
                        globalActiveContext.needsReset = true;
                    }
                    console.error('[DEBUG] cleanupAfterTest timed out, setting needsReset = true');
                }
                logPerf('cleanupAfterTest: main cleanup', cleanupEvalStart);
            } catch (_err) {
                // Ignore reset errors
            }
        }

        deleteWatchmanWatches(this.openedRepos);
        this.openedRepos = [];

        logPerf('cleanupAfterTest: total', start);
    }

    async evaluate<T>(
        fn: (vscode: typeof vscodeType, api: ExtensionApi, ...args: unknown[]) => Promise<T> | T,
        ...args: unknown[]
    ): Promise<T> {
        const res = await sendEvaluation(this.userDataDir, 'evaluate', fn, args);
        return res.result as T;
    }

    async evaluateHandle(
        fn: (vscode: typeof vscodeType, api: ExtensionApi, ...args: unknown[]) => unknown,
        ...args: unknown[]
    ): Promise<{ __vscode_handle__: string }> {
        const res = await sendEvaluation(this.userDataDir, 'evaluateHandle', fn, args);
        return { __vscode_handle__: res.handleId as string };
    }

    async releaseHandle(handle: { __vscode_handle__: string }): Promise<void> {
        await sendEvaluation(this.userDataDir, 'releaseHandle', undefined, [], handle.__vscode_handle__);
    }

    async closeAllEditors(): Promise<void> {
        await this.evaluate((vscode) => {
            return vscode.commands.executeCommand('workbench.action.closeAllEditors', {
                skipConfirm: true,
            });
        });
    }

    async clearRepositoryManager(): Promise<void> {
        await this.evaluate((_vscode, api) => {
            return api.repositoryManager.clear();
        });
    }

    async executeCommand<T>(command: string, ...args: unknown[]): Promise<T> {
        return this.evaluate(
            (vscode, _api, cmd, cmdArgs) => {
                if (typeof cmd !== 'string') {
                    throw new Error('cmd must be a string');
                }
                const resolvedArgs = Array.isArray(cmdArgs) ? cmdArgs : [];
                return Promise.resolve(vscode.commands.executeCommand<T>(cmd, ...resolvedArgs));
            },
            command,
            args,
        );
    }

    async executeCommandWithSaveDialog(
        command: string,
        action: 'Save' | "Don't Save" | 'Cancel',
        ...args: unknown[]
    ): Promise<void> {
        let evaluateDone = false;
        const evaluatePromise = this.executeCommand(command, ...args).catch(() => {});

        evaluatePromise.finally(() => {
            evaluateDone = true;
        });

        if (this.page) {
            const dialog = this.page
                .locator('.monaco-dialog-box')
                .filter({ hasText: /Do you want to save the changes/ });
            while (!evaluateDone) {
                try {
                    if (this.page.isClosed()) {
                        break;
                    }
                    if (await dialog.isVisible()) {
                        if (action === 'Cancel') {
                            await this.page.keyboard.press('Escape');
                        } else {
                            const btnName = action === "Don't Save" ? /don['’]t save/i : action;
                            const btn = dialog.getByRole('button', { name: btnName, exact: action !== "Don't Save" });
                            if (await btn.isVisible()) {
                                await btn.click();
                            }
                        }
                    }
                } catch {
                    // Ignore timeout waiting for dialog
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        await evaluatePromise;
    }

    async openFolder(folderPath: string): Promise<void> {
        await this.evaluate((vscode, api, pathVal) => {
            const uri = vscode.Uri.file(pathVal as string);
            const workspaceFolders = vscode.workspace.workspaceFolders || [];
            if (workspaceFolders.length > 1) {
                vscode.workspace.updateWorkspaceFolders(1, 1, { uri });
            } else {
                vscode.workspace.updateWorkspaceFolders(1, 0, { uri });
            }
            return api.repositoryManager.scanForRepositories();
        }, folderPath);
    }

    async openFileInEditor(absolutePath: string): Promise<void> {
        await this.evaluate(async (vscode, _api, filePath) => {
            if (typeof filePath !== 'string') {
                throw new Error('filePath must be a string');
            }
            let uri: vscodeType.Uri;
            if (filePath.startsWith('/') || filePath.includes(':\\') || filePath.includes(':/')) {
                uri = vscode.Uri.file(filePath);
            } else {
                const files = await vscode.workspace.findFiles(`**/${filePath}`);
                if (files.length > 0) {
                    uri = files[0];
                } else {
                    const folders = vscode.workspace.workspaceFolders || [];
                    if (folders.length > 0) {
                        uri = vscode.Uri.joinPath(folders[0].uri, filePath);
                    } else {
                        uri = vscode.Uri.file(filePath);
                    }
                }
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        }, absolutePath);
    }

    async getOutputChannelLogs(channelName?: string): Promise<string> {
        if (!this.userDataDir) {
            return '';
        }
        const logsDir = path.join(this.userDataDir, 'logs');
        if (!fs.existsSync(logsDir)) {
            return '';
        }

        const findLogFiles = (dir: string): string[] => {
            let results: string[] = [];
            if (!fs.existsSync(dir)) {
                return results;
            }
            const list = fs.readdirSync(dir, { withFileTypes: true });
            for (const file of list) {
                const fullPath = path.join(dir, file.name);
                if (file.isDirectory()) {
                    results = results.concat(findLogFiles(fullPath));
                } else if (
                    file.isFile() &&
                    file.name.endsWith('.log') &&
                    (!channelName || file.name.toLowerCase().includes(channelName.toLowerCase()))
                ) {
                    results.push(fullPath);
                }
            }
            return results;
        };

        const logFiles = findLogFiles(logsDir);
        if (logFiles.length === 0) {
            return '';
        }

        const filesWithStats = logFiles.map((filePath) => ({
            filePath,
            stat: fs.statSync(filePath),
        }));
        filesWithStats.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        let combinedLogs = '';
        for (const { filePath } of filesWithStats) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                combinedLogs += `\n--- LOG FILE: ${path.relative(this.userDataDir, filePath)} ---\n${content}\n`;
            } catch {
                // Ignore read errors
            }
        }
        return combinedLogs;
    }
}

export const test = baseTest.extend<
    {
        vscode: VSCodeFixture;
    },
    {
        vscodeWorker: VSCodeWorker;
    }
>({
    vscodeWorker: [
        async ({ browserName: _ }, use, workerInfo) => {
            const worker = new VSCodeWorker();
            const debugDir = path.join(workerInfo.project.outputDir, 'debug-logs');
            fs.mkdirSync(debugDir, { recursive: true });
            process.env.JJ_VIEW_DEBUG_LOG = path.join(debugDir, `worker-${workerInfo.workerIndex}.log`);
            await worker.init();
            await use(worker);
            await worker.cleanup();
        },
        { scope: 'worker' },
    ],

    vscode: async ({ vscodeWorker }, use, testInfo) => {
        const fixture = new VSCodeFixtureImpl(vscodeWorker);
        await use(fixture);
        if (testInfo.status && testInfo.status !== 'passed' && testInfo.status !== 'skipped' && fixture.page) {
            try {
                const artifactDir = path.join(testInfo.outputDir, Math.random().toString(36).substring(2, 10));
                fs.mkdirSync(artifactDir, { recursive: true });
                const pngPath = path.join(artifactDir, 'dialog-failure.png');
                const htmlPath = path.join(artifactDir, 'dialog-failure.html');

                // Capture screenshot
                await fixture.page.screenshot({ path: pngPath });

                // Capture HTML
                const html = await fixture.page.locator('body').innerHTML();
                fs.writeFileSync(htmlPath, html, 'utf-8');

                // Attach to Playwright's testInfo so they are linked in the test reports
                testInfo.attachments.push({
                    name: 'dialog-failure.png',
                    path: pngPath,
                    contentType: 'image/png',
                });
                testInfo.attachments.push({
                    name: 'dialog-failure.html',
                    path: htmlPath,
                    contentType: 'text/html',
                });

                let logMsg = '';
                if (fixture.userDataDir) {
                    const logsDir = path.join(fixture.userDataDir, 'logs');
                    if (fs.existsSync(logsDir)) {
                        const findJujutsuLogFiles = (dir: string): string[] => {
                            let results: string[] = [];
                            const list = fs.readdirSync(dir, { withFileTypes: true });
                            for (const file of list) {
                                const fullPath = path.join(dir, file.name);
                                if (file.isDirectory()) {
                                    results = results.concat(findJujutsuLogFiles(fullPath));
                                } else if (
                                    file.isFile() &&
                                    file.name.endsWith('.log') &&
                                    file.name.toLowerCase().includes('jujutsu')
                                ) {
                                    results.push(fullPath);
                                }
                            }
                            return results;
                        };
                        const jujutsuLogFiles = findJujutsuLogFiles(logsDir);
                        for (const filePath of jujutsuLogFiles) {
                            try {
                                const destName = `jujutsu-${path.basename(filePath)}`;
                                const destPath = path.join(artifactDir, destName);
                                fs.copyFileSync(filePath, destPath);
                                testInfo.attachments.push({
                                    name: destName,
                                    path: destPath,
                                    contentType: 'text/plain',
                                });
                                logMsg += `  - Jujutsu Log: file://${destPath}\n`;
                            } catch (copyErr) {
                                console.error(`Failed to copy log file ${filePath}:`, copyErr);
                            }
                        }
                    }
                }

                console.error(
                    `\nTest failed. Diagnostic files saved:\n  - Screenshot: file://${pngPath}\n  - DOM HTML: file://${htmlPath}\n${logMsg}`,
                );
            } catch (diagErr) {
                console.error('Failed to capture diagnostics:', diagErr);
            }
        }
        await fixture.cleanupAfterTest();
    },
});
