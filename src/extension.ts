/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeForgeAuthManager } from './code-forge-auth';
import type { CodeForgeProvider } from './code-forge-provider';
import type { CodeForgeProviderFactory } from './code-forge-provider-factory';
import { CodeForgeRegistry } from './code-forge-registry';
import type { CodeForgeService } from './code-forge-service';
import { getSquashStorageDir, isSquashInProgress } from './commands/squash-revision';
import { CommentsManager } from './comments-manager';
import { GerritProvider } from './gerrit-provider';
import { GitHubProvider } from './github-provider';
import { GitLabProvider } from './gitlab-provider';
import { JjContextKey } from './jj-context-keys';
import { JjEditFsService } from './jj-edit-fs-service';
import { JjMergeService } from './jj-merge-service';
import { JjProcessTracker } from './jj-process-tracker';
import { JjRepositoryManager } from './jj-repository-manager';
import { JjViewFsService } from './jj-view-fs-service';
import { getUriParams } from './uri-utils';
import { resolveJjBinary } from './utils/binary-utils';
import { getJjViewConfig } from './utils/config-utils';
import { toError } from './utils/error-utils';
import { type LoggerChannel, OutputChannel } from './utils/output-channel';
import { checkGitColocation } from './vscode/git-colocation';
import { VsCodeCommentsProvider } from './vscode/providers/vscode-comments-provider';
import { VsCodeCommitDetailsEditorProvider } from './vscode/providers/vscode-commit-details-editor-provider';
import { VsCodeEditFsProvider } from './vscode/providers/vscode-edit-fs-provider';
import { VsCodeLogWebviewProvider } from './vscode/providers/vscode-log-webview-provider';
import { VsCodeMergeContentProvider } from './vscode/providers/vscode-merge-provider';
import { VsCodeProcessMonitorProvider } from './vscode/providers/vscode-process-monitor-provider';
import { VsCodeScmProvider } from './vscode/providers/vscode-scm-provider';
import { VsCodeViewFsProvider } from './vscode/providers/vscode-view-fs-provider';
import { registerVSCodeCommands } from './vscode/register-commands';
import { registerProcessMonitorCommands } from './vscode/register-process-monitor-commands';
import { VsCodeHostEnvironment } from './vscode/vscode-host-environment';

export interface Api {
    repositoryManager: JjRepositoryManager;
    scmProviders: Map<string, VsCodeScmProvider>;
    commentsManager: CommentsManager;
    commentsProvider: VsCodeCommentsProvider;
    registerCodeForgeProvider(factory: CodeForgeProviderFactory): vscode.Disposable;
    resetState(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
    const folders = vscode.workspace.workspaceFolders || [];
    const workspaceRoot = folders.length > 0 ? folders[0].uri.fsPath : '';
    const realOutputChannel = vscode.window.createOutputChannel('JJ View', { log: true });
    const outputChannel = new OutputChannel(realOutputChannel);
    context.subscriptions.push(realOutputChannel);

    // Get preferred binary path configuration
    const preferredPath = getJjViewConfig<string>('binaryPath');
    let resolvedBinaryPath: string | undefined;
    try {
        resolvedBinaryPath = await resolveJjBinary(preferredPath, workspaceRoot);
    } catch {
        // Ignore initial error, updateBinaryPath() below will show notification
    }

    // Configure configurations update listener
    const updateBinaryPath = async () => {
        const preferredPath = getJjViewConfig<string>('binaryPath');

        let resolvedPath: string | undefined;
        let errorMessage: string | undefined;

        try {
            resolvedPath = await resolveJjBinary(preferredPath, workspaceRoot);
            if (!resolvedPath) {
                errorMessage = `Could not find 'jj' binary. Please ensure 'jj' is installed and in your PATH, or configure its path manually.`;
            }
        } catch (e: unknown) {
            errorMessage = `Invalid 'jj' binary configuration: ${(e as Error).message}`;
        }

        if (resolvedPath) {
            repositoryManager.setBinaryPath(resolvedPath);
            outputChannel.info(`[Extension] Using jj binary at: ${resolvedPath}`);
        } else if (errorMessage) {
            showBinaryError(errorMessage);
        }
    };

    const showBinaryError = (message: string) => {
        const CONFIGURE = 'Configure Path';
        vscode.window.showErrorMessage(message, CONFIGURE).then((selection) => {
            if (selection === CONFIGURE) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'jj-view.binaryPath');
            }
        });
    };

    const setOpenDiffOnClickContext = () => {
        const value = getJjViewConfig<boolean>('openDiffOnClick', true);
        vscode.commands.executeCommand('setContext', JjContextKey.OpenDiffOnClick, value);
    };
    setOpenDiffOnClickContext();

    const codeForgeRegistry = new CodeForgeRegistry();
    context.subscriptions.push(codeForgeRegistry);
    const authManager = new CodeForgeAuthManager(context, outputChannel);
    context.subscriptions.push(authManager);

    context.subscriptions.push(
        codeForgeRegistry.register({
            id: 'gerrit',
            create: (outputChannel) => new GerritProvider(outputChannel),
        }),
    );
    context.subscriptions.push(
        codeForgeRegistry.register({
            id: 'github',
            create: (outputChannel) => new GitHubProvider(authManager, outputChannel),
        }),
    );
    context.subscriptions.push(
        codeForgeRegistry.register({
            id: 'gitlab',
            create: (outputChannel) => new GitLabProvider(authManager, outputChannel),
        }),
    );

    const processTracker = new JjProcessTracker();
    context.subscriptions.push(processTracker);
    const processStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    processStatusBarItem.command = 'jj-view.showProcessMonitor';
    context.subscriptions.push(processStatusBarItem);

    const updateProcessStatusBar = () => {
        const showProcessMonitor = vscode.workspace
            .getConfiguration('jj-view')
            .get<boolean>('showProcessMonitorPanel', false);
        const metrics = processTracker.getMetrics();
        if (showProcessMonitor && metrics.activeCount > 0) {
            processStatusBarItem.text = `$(sync~spin) JJ: ${metrics.activeCount} running`;
            processStatusBarItem.tooltip = `${metrics.activeCount} JJ process(es) running. Click to open Process Monitor.`;
            processStatusBarItem.show();
        } else {
            processStatusBarItem.hide();
        }
    };

    context.subscriptions.push(processTracker.onDidChangeProcesses(updateProcessStatusBar));

    registerProcessMonitorCommands(context, processTracker);

    const hostEnvironment = new VsCodeHostEnvironment({ context });
    context.subscriptions.push(hostEnvironment);

    const repositoryManager = new JjRepositoryManager(
        codeForgeRegistry,
        outputChannel,
        hostEnvironment,
        resolvedBinaryPath,
        processTracker,
    );
    context.subscriptions.push(repositoryManager);

    // Listen to authentication successes from AuthManager and re-detect provider to trigger refresh
    context.subscriptions.push(
        authManager.onDidAuthenticate(() => {
            for (const repo of repositoryManager.repositories) {
                repo.codeForge
                    .detectActiveProvider(true)
                    .then((changed) => {
                        if (!changed) {
                            repo.codeForge.forceRefresh();
                        }
                    })
                    .catch((e: unknown) => {
                        outputChannel.error('Failed to refresh after authentication', toError(e));
                    });
            }
        }),
    );

    const commentsManager = new CommentsManager(repositoryManager, hostEnvironment);
    context.subscriptions.push(commentsManager);
    const commentsProvider = new VsCodeCommentsProvider(commentsManager);
    context.subscriptions.push(commentsProvider);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('jj-view.showProcessMonitorPanel')) {
                updateProcessStatusBar();
            }
            if (e.affectsConfiguration('jj-view.binaryPath')) {
                await updateBinaryPath();
                await repositoryManager.scanForRepositories();
            }
            if (e.affectsConfiguration('jj-view.openDiffOnClick')) {
                setOpenDiffOnClickContext();
                await Promise.all(
                    Array.from(scmProviders.values()).map((scm) =>
                        scm.repo.refresh({ reason: 'openDiffOnClick config change' }),
                    ),
                );
            }
            if (
                e.affectsConfiguration('jj-view.autoRepositoryDetection') ||
                e.affectsConfiguration('jj-view.scanRepositories') ||
                e.affectsConfiguration('jj-view.ignoredRepositories')
            ) {
                await repositoryManager.scanForRepositories();
            }
            if (
                e.affectsConfiguration('jj-view.commit') ||
                e.affectsConfiguration('jj-view.minChangeIdLength') ||
                e.affectsConfiguration('jj-view.logTheme')
            ) {
                await commitDetailsProvider.refresh('config change');
            }
        }),
    );

    // Track active provider changes to update context keys
    const updateContextKeys = (provider: CodeForgeProvider | undefined) => {
        vscode.commands.executeCommand('setContext', 'jj.codeForgeActive', !!provider);
        vscode.commands.executeCommand('setContext', 'jj.codeForgeProvider', provider?.id);
        const manageable = !!provider?.isAuthManageable;
        vscode.commands.executeCommand('setContext', 'jj.codeForgeAuthManageable', manageable);
        vscode.commands.executeCommand(
            'setContext',
            'jj.codeForgeTerm',
            provider?.changeTerm?.toLowerCase() || 'change',
        );
    };
    updateContextKeys(undefined);

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.manageAuth', async () => {
            const focused = repositoryManager.focusedRepository;
            const activeProvider = focused?.codeForge.activeProvider;
            if (!activeProvider) {
                vscode.window.showErrorMessage('No active code forge provider detected.');
                return;
            }
            if (!activeProvider.isAuthManageable) {
                vscode.window.showInformationMessage(
                    `Authentication management is not supported for ${activeProvider.displayName}.`,
                );
                return;
            }

            const providerId = activeProvider.id;
            const isSkipped = authManager.isAuthSkipped(providerId);
            const items: (vscode.QuickPickItem & { execute(): Promise<void> })[] = [];

            if (!(await activeProvider.hasAuth?.())) {
                items.push({
                    label: isSkipped
                        ? '$(pass) Enable Authentication Prompts'
                        : '$(circle-slash) Disable Authentication Prompts',
                    description: `Currently ${isSkipped ? 'disabled (skipped)' : 'enabled'} for ${activeProvider.displayName}`,
                    execute: async () => {
                        await authManager.setAuthSkipped(providerId, !isSkipped);
                        vscode.window.showInformationMessage(
                            `Authentication prompts for ${activeProvider.displayName} have been ${!isSkipped ? 'disabled' : 'enabled'}.`,
                        );
                        const focused = repositoryManager.focusedRepository;
                        if (focused) {
                            focused.codeForge.forceRefresh();
                        }
                    },
                });
            }

            for (const item of (await activeProvider.getAuthManageItems?.()) ?? []) {
                items.push({
                    label: item.label,
                    description: item.description,
                    detail: item.detail,
                    execute: () => item.execute(),
                });
            }

            items.push({
                label: '$(refresh) Reset All Preferences',
                description: 'Reset auth preferences for all code forge providers',
                execute: async () => {
                    await authManager.resetAllChoices();
                    vscode.window.showInformationMessage('Authentication preferences have been reset.');
                    const focused = repositoryManager.focusedRepository;
                    if (focused) {
                        focused.codeForge.forceRefresh();
                    }
                },
            });

            const choice = await vscode.window.showQuickPick(items, {
                placeHolder: `Manage Authentication for ${activeProvider.displayName}`,
            });

            if (!choice) {
                return;
            }

            await choice.execute();
        }),
    );

    const viewFsService = new JjViewFsService(repositoryManager);
    const viewFileSystemProvider = new VsCodeViewFsProvider(viewFsService);

    const editFsService = new JjEditFsService(repositoryManager);
    const editFileSystemProvider = new VsCodeEditFsProvider(editFsService);

    // Register FileSystemProvider for read-only access to old file versions (for diffs)
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('jj-view', viewFileSystemProvider, { isReadonly: true }),
    );

    // Register FileSystemProvider for editable access to mutable revision files
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('jj-edit', editFileSystemProvider));

    // Register ContentProvider for virtual merge output documents
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('jj-merge-output', {
            provideTextDocumentContent(uri) {
                const repo = repositoryManager.getRepositoryForUri(uri);
                if (!repo) {
                    return '';
                }
                const mergeService = new JjMergeService(repo.jj);
                const mergeProvider = new VsCodeMergeContentProvider(mergeService);
                return mergeProvider.provideTextDocumentContent(uri);
            },
        }),
    );

    // Handle saving of virtual merge output
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (doc.uri.scheme === 'jj-merge-output') {
                const query = getUriParams(doc.uri);
                const fsPath = query.get('path');
                if (fsPath) {
                    try {
                        await fs.writeFile(fsPath, doc.getText());
                    } catch (e) {
                        vscode.window.showErrorMessage(`Failed to save merge result: ${e}`);
                    }
                }
            }
        }),
    );

    // Finalize squash when the SQUASH_MSG tab is closed
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(async (e) => {
            for (const tab of e.closed) {
                if (tab.input instanceof vscode.TabInputText && path.basename(tab.input.uri.fsPath) === 'SQUASH_MSG') {
                    const focused = repositoryManager.focusedRepository;
                    if (!focused) {
                        return;
                    }
                    const storageDir = getSquashStorageDir(focused.jj.workspaceRoot);
                    const metaPath = path.join(storageDir, 'SQUASH_META.json');

                    try {
                        await fs.access(metaPath);
                        if (isSquashInProgress(focused.jj.workspaceRoot)) {
                            return;
                        }

                        await vscode.commands.executeCommand('jj-view.completeSquashRevision');
                    } catch {
                        // No pending squash, ignore
                    }
                }
            }
        }),
    );

    const scmProviders = new Map<string, VsCodeScmProvider>();
    const activeScmSubscriptions = new Map<string, vscode.Disposable>();

    // Wire up edit provider refresh
    editFileSystemProvider.onDidWrite = (repo) => {
        const scm = scmProviders.get(repo.rootUri.fsPath);
        scm?.refresh();
    };

    const commitDetailsProvider = new VsCodeCommitDetailsEditorProvider(
        context.extensionUri,
        repositoryManager,
        context,
    );
    context.subscriptions.push(
        commitDetailsProvider,
        vscode.window.registerCustomEditorProvider(VsCodeCommitDetailsEditorProvider.viewType, commitDetailsProvider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
    );

    // Get an initial repo for webview log startup
    const logWebviewProvider = new VsCodeLogWebviewProvider(
        context.extensionUri,
        undefined,
        (ids) => {
            const focused = repositoryManager.focusedRepository;
            if (focused) {
                const scm = scmProviders.get(focused.rootUri.fsPath);
                scm?.handleSelectionChange(ids);
            }
        },
        context,
        outputChannel,
    );
    context.subscriptions.push(
        logWebviewProvider,
        vscode.window.registerWebviewViewProvider(VsCodeLogWebviewProvider.viewType, logWebviewProvider),
    );

    const processMonitorProvider = new VsCodeProcessMonitorProvider(context.extensionUri, processTracker, context);
    context.subscriptions.push(
        processMonitorProvider,
        vscode.window.registerWebviewViewProvider(VsCodeProcessMonitorProvider.viewType, processMonitorProvider),
    );

    context.subscriptions.push(
        commitDetailsProvider.onDidClosePanel((changeId) => {
            logWebviewProvider.controller.handlePanelClosed(changeId);
        }),
    );

    // SCM Discovery Lifecycle integration
    repositoryManager.onDidOpenRepository((repo) => {
        const repoPrefix = path.basename(repo.rootUri.fsPath);
        const repoOutputChannel = new OutputChannel(realOutputChannel, repoPrefix);
        const scmProvider = new VsCodeScmProvider(
            context,
            repo,
            repoOutputChannel,
            repositoryManager,
            viewFileSystemProvider,
            editFileSystemProvider,
            () => repositoryManager.focusedRepository?.rootUri.fsPath === repo.rootUri.fsPath,
        );

        const decorationProvider = vscode.window.registerFileDecorationProvider(scmProvider.decorationProvider);
        const repoStatusSub = repo.onDidStatusChange(async (event) => {
            if (repositoryManager.focusedRepository?.rootUri.fsPath === repo.rootUri.fsPath) {
                // Update context keys for focused repo
                vscode.commands.executeCommand('setContext', JjContextKey.ParentMutable, scmProvider.parentMutable);
                vscode.commands.executeCommand('setContext', JjContextKey.HasChild, scmProvider.hasChild);

                // Refresh webview and commit details panel in parallel
                await Promise.all([
                    logWebviewProvider.controller.refresh(event.reason),
                    commitDetailsProvider.refresh(event.reason),
                ]);
            }
        });

        const composite = vscode.Disposable.from(scmProvider, decorationProvider, repoStatusSub);
        scmProviders.set(repo.rootUri.fsPath, scmProvider);
        activeScmSubscriptions.set(repo.rootUri.fsPath, composite);

        if (
            !logWebviewProvider.repository ||
            repositoryManager.focusedRepository?.rootUri.fsPath === repo.rootUri.fsPath
        ) {
            logWebviewProvider.updateRepository(repo).catch((err) => {
                outputChannel.error('[Extension] Failed to update webview repository', toError(err));
            });
        }

        // Fire and forget: check if we should warn about git colocation
        checkGitColocation(repo.jj).catch((e) => {
            outputChannel.error(`[Extension] Colocation check failed for ${repoPrefix}`, toError(e));
        });
    });

    repositoryManager.onDidCloseRepository(async (repo) => {
        const sub = activeScmSubscriptions.get(repo.rootUri.fsPath);
        if (sub) {
            sub.dispose();
            activeScmSubscriptions.delete(repo.rootUri.fsPath);
        }
        scmProviders.delete(repo.rootUri.fsPath);
    });

    let focusedRepoActiveProviderSub: vscode.Disposable | undefined;
    repositoryManager.onDidChangeFocusedRepository((repo) => {
        focusedRepoActiveProviderSub?.dispose();
        if (repo) {
            logWebviewProvider.updateRepository(repo).catch((err) => {
                outputChannel.error('[Extension] Failed to update webview repository', toError(err));
            });
            const scm = scmProviders.get(repo.rootUri.fsPath);
            if (scm) {
                vscode.commands.executeCommand('setContext', JjContextKey.ParentMutable, scm.parentMutable);
                vscode.commands.executeCommand('setContext', JjContextKey.HasChild, scm.hasChild);
            }
            focusedRepoActiveProviderSub = repo.codeForge.onDidActiveProviderChange((provider) => {
                updateContextKeys(provider);
            });
            // Force active provider detection for the focused repo and then update context keys immediately
            repo.codeForge.detectActiveProvider(true).then(() => {
                if (repositoryManager.focusedRepository === repo) {
                    updateContextKeys(repo.codeForge.activeProvider);
                }
            });
        } else {
            focusedRepoActiveProviderSub = undefined;
            updateContextKeys(undefined);
        }
    });

    registerVSCodeCommands({
        context,
        repositoryManager,
        scmProviders,
        outputChannel,
        commentsManager,
        logWebviewProvider,
    });

    context.subscriptions.push(
        vscode.window.onDidEndTerminalShellExecution((event) => {
            const focused = repositoryManager.focusedRepository;
            if (focused) {
                const scm = scmProviders.get(focused.rootUri.fsPath);
                if (scm) {
                    handleTerminalExecution(event.execution.commandLine.value, focused.codeForge, outputChannel, scm);
                }
            }
        }),
    );

    // Load cached repositories immediately
    await repositoryManager.restoreCachedRepositories();

    // Trigger initial scan (non-blocking)
    if (!resolvedBinaryPath) {
        updateBinaryPath().then(() => repositoryManager.scanForRepositories());
    } else {
        repositoryManager.scanForRepositories();
    }

    return {
        repositoryManager,
        scmProviders,
        commentsManager,
        commentsProvider,
        registerCodeForgeProvider: (factory: CodeForgeProviderFactory) => codeForgeRegistry.register(factory),
        resetState: async () => {
            await authManager.resetAllChoices();
            try {
                await authManager.secrets.delete('gitlab_token');
                await authManager.secrets.delete('github_token');
            } catch {}
            for (const key of context.globalState?.keys?.() ?? []) {
                await context.globalState.update(key, undefined);
            }
            for (const key of context.workspaceState?.keys?.() ?? []) {
                await context.workspaceState.update(key, undefined);
            }
            await repositoryManager.clear();
        },
    };
}

/** Checks if a terminal command is a jj upload or push and triggers staggered code forge refreshes. */
export function handleTerminalExecution(
    commandLine: string,
    codeForgeService: CodeForgeService,
    outputChannel: LoggerChannel,
    scmProvider: VsCodeScmProvider,
): boolean {
    const cmd = commandLine.trim();
    if (cmd.startsWith('jj') && (cmd.includes('upload') || cmd.includes('git push'))) {
        outputChannel.info(`[Extension] Detected terminal upload/push: "${cmd}"`);
        codeForgeService.requestRefreshWithBackoffs();
        scmProvider.refresh({ reason: 'terminal upload/push' });
        return true;
    }
    return false;
}

export function deactivate() {}
