/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeForgeAuthManager } from './code-forge-auth';
import type { CodeForgeProvider } from './code-forge-provider';
import type { CodeForgeProviderFactory } from './code-forge-provider-factory';
import { CodeForgeRegistry } from './code-forge-registry';
import type { CodeForgeService } from './code-forge-service';
import { abandonCommand } from './commands/abandon';
import { absorbCommand } from './commands/absorb';
import { setBookmarkCommand } from './commands/bookmark';
import { advanceBookmarkCommand } from './commands/bookmark-advance';
import { advanceBookmarkAndUploadCommand } from './commands/bookmark-advance-upload';
import { deleteBookmarkCommand } from './commands/bookmark-delete';
import { resolveRepository } from './commands/command-utils';
import {
    ackCommentCommand,
    copyUnresolvedCommentsCommand,
    doneCommentCommand,
    replyAndResolveCommentCommand,
    replyCommentCommand,
    resolveCommentThreadCommand,
    showCommentsCommand,
    unresolveCommentThreadCommand,
} from './commands/comments';
import { commitCommand } from './commands/commit';
import { commitPromptCommand } from './commands/commit-prompt';
import { compareAllFilesWithRevisionCommand } from './commands/compare-all-files-with-revision';
import { compareFileWithRevisionCommand } from './commands/compare-file-with-revision';
import { setDescriptionCommand } from './commands/describe';
import { describePromptCommand } from './commands/describe-prompt';
import { showDetailsCommand } from './commands/details';
import { discardChangeCommand } from './commands/discard-change';
import { duplicateCommand } from './commands/duplicate';
import { editCommand } from './commands/edit';
import { focusDescriptionInputCommand } from './commands/focus-description-input';
import { type MergeCommandArg, newMergeChangeCommand } from './commands/merge';
import { openMergeEditorCommand } from './commands/merge-editor';
import { showMultiFileDiffCommand } from './commands/multi-diff';
import { newCommand } from './commands/new';
import { newAfterCommand } from './commands/new-after';
import { newBeforeCommand } from './commands/new-before';
import { openChangesCommand, openFileCommand } from './commands/open';
import { registerProcessMonitorCommands } from './commands/process-monitor';
import { type CommitMenuContext, rebaseOntoSelectedCommand } from './commands/rebase';
import { redoCommand } from './commands/redo';
import { refreshCommand } from './commands/refresh';
import { restoreCommand } from './commands/restore';
import {
    squashFilesIntoAncestorCommand,
    squashFilesIntoChildCommand,
    squashFilesIntoParentCommand,
} from './commands/squash-files';
import {
    completeSquashRevisionCommand,
    squashRevisionIntoAncestorCommand,
    squashRevisionIntoParentCommand,
} from './commands/squash-revision';
import { squashHunkIntoParentCommand, squashSelectionIntoParentCommand } from './commands/squash-selection';
import { undoCommand } from './commands/undo';
import { uploadCommand } from './commands/upload';
import { viewFileAtRevisionCommand } from './commands/view-file-at-revision';
import { workspaceAddCommand } from './commands/workspace-add';
import { workspaceDeleteCommand } from './commands/workspace-delete';
import { workspaceForgetCommand } from './commands/workspace-forget';
import { workspaceOpenInCurrentWindowCommand, workspaceOpenInNewWindowCommand } from './commands/workspace-open';
import { CommentsManager } from './comments-manager';
import { GerritProvider } from './gerrit-provider';
import { checkGitColocation } from './git-colocation';
import { GitHubProvider } from './github-provider';
import { GitLabProvider } from './gitlab-provider';
import { JjCommitDetailsEditorProvider } from './jj-commit-details-editor-provider';
import { JjContextKey } from './jj-context-keys';
import { JjEditFileSystemProvider } from './jj-edit-fs-provider';
import { JjLogWebviewProvider } from './jj-log-webview-provider';
import { JjProcessMonitorProvider } from './jj-process-monitor-provider';
import { JjProcessTracker } from './jj-process-tracker';
import { JjRepositoryManager } from './jj-repository-manager';
import { JjScmProvider } from './jj-scm-provider';
import type { JjService } from './jj-service';
import { TOGGLEABLE_COMMIT_ACTIONS } from './jj-types';
import { JjViewFileSystemProvider } from './jj-view-fs-provider';
import type { JjResourceState } from './scm-resource-state';
import { resolveJjBinary } from './utils/binary-utils';
import { getJjViewConfig } from './utils/config-utils';
import type { JjLoggerChannel } from './utils/output-channel';
import { JjOutputChannel } from './utils/output-channel';

export interface Api {
    repositoryManager: JjRepositoryManager;
    scmProviders: Map<string, JjScmProvider>;
    commentsManager: CommentsManager;
    registerCodeForgeProvider(factory: CodeForgeProviderFactory): vscode.Disposable;
}

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
    const folders = vscode.workspace.workspaceFolders || [];
    const workspaceRoot = folders.length > 0 ? folders[0].uri.fsPath : '';
    const realOutputChannel = vscode.window.createOutputChannel('JJ View', { log: true });
    const outputChannel = new JjOutputChannel(realOutputChannel);
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

    const repositoryManager = new JjRepositoryManager(
        codeForgeRegistry,
        outputChannel,
        context.workspaceState,
        resolvedBinaryPath,
        processTracker,
    );
    context.subscriptions.push(repositoryManager);

    const commentsManager = new CommentsManager(repositoryManager);
    context.subscriptions.push(commentsManager);

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

    const viewFileSystemProvider = new JjViewFileSystemProvider(repositoryManager);
    const editFileSystemProvider = new JjEditFileSystemProvider(repositoryManager);

    // Register FileSystemProvider for read-only access to old file versions (for diffs)
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('jj-view', viewFileSystemProvider, { isReadonly: true }),
    );

    // Register FileSystemProvider for editable access to mutable revision files
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('jj-edit', editFileSystemProvider));

    const scmProviders = new Map<string, JjScmProvider>();
    const activeScmSubscriptions = new Map<string, vscode.Disposable>();

    // Wire up edit provider refresh
    editFileSystemProvider.onDidWrite = (repo) => {
        const scm = scmProviders.get(repo.rootUri.fsPath);
        scm?.refresh();
    };

    const commitDetailsProvider = new JjCommitDetailsEditorProvider(context.extensionUri, repositoryManager);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(JjCommitDetailsEditorProvider.viewType, commitDetailsProvider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
    );

    // Get an initial repo for webview log startup
    const logWebviewProvider = new JjLogWebviewProvider(
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
        vscode.window.registerWebviewViewProvider(JjLogWebviewProvider.viewType, logWebviewProvider),
    );

    const processMonitorProvider = new JjProcessMonitorProvider(context.extensionUri, processTracker);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(JjProcessMonitorProvider.viewType, processMonitorProvider),
    );

    context.subscriptions.push(
        commitDetailsProvider.onDidClosePanel((changeId) => {
            logWebviewProvider.handlePanelClosed(changeId);
        }),
    );

    // SCM Discovery Lifecycle integration
    repositoryManager.onDidOpenRepository((repo) => {
        const repoPrefix = path.basename(repo.rootUri.fsPath);
        const repoOutputChannel = new JjOutputChannel(realOutputChannel, repoPrefix);
        const scmProvider = new JjScmProvider(
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
                    logWebviewProvider.refresh(event.reason),
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
                outputChannel.error(`[Extension] Failed to update webview repository: ${err}`);
            });
        }

        // Fire and forget: check if we should warn about git colocation
        checkGitColocation(repo.jj).catch((e) =>
            outputChannel.error(`[Extension] Colocation check failed for ${repoPrefix}: ${e}`),
        );
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
                outputChannel.error(`[Extension] Failed to update webview repository: ${err}`);
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

    // Helper to contextually resolve SCM & JjService based on command arguments or editor focus
    const resolveRepositoryLocal = (args: unknown[]) => resolveRepository(args, repositoryManager, scmProviders);

    // Command Wrap utility
    function registerWrappedCommand(
        commandId: string,
        handler: (scm: JjScmProvider, jj: JjService, ...args: unknown[]) => unknown,
    ): vscode.Disposable {
        return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
            const context = resolveRepositoryLocal(args);
            if (context) {
                repositoryManager.setFocusedRepository(context.repo);
                return await handler(context.scm, context.repo.jj, ...args);
            } else {
                outputChannel.error(`[Command Error] Failed to resolve repository for command: ${commandId}`);
                return;
            }
        });
    }

    // Register all wrapped commands
    context.subscriptions.push(
        registerWrappedCommand('jj-view.focusRepository', () => {
            // No-op: registerWrappedCommand automatically resolves the clicked repository's rootUri and sets it as the focused repository.
        }),
        registerWrappedCommand('jj-view.new', async (scm, jj, ...args) => {
            await newCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.newMergeChange', async (scm, jj, ...args) => {
            const arg = args[0] as MergeCommandArg | undefined;
            await newMergeChangeCommand(scm, jj, arg);
        }),
        registerWrappedCommand('jj-view.commit', async (scm, jj) => {
            await commitCommand(scm, jj);
        }),
        registerWrappedCommand('jj-view.commitPrompt', async (scm, jj) => {
            await commitPromptCommand(scm, jj);
        }),
        registerWrappedCommand('jj-view.describePrompt', async (scm, jj) => {
            await describePromptCommand(scm, jj);
        }),
    );

    // focusDescriptionInput doesn't need repo context — it just focuses the SCM view
    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.focusDescriptionInput', async () => {
            await focusDescriptionInputCommand();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.showComments', async (changeId?: string) => {
            await showCommentsCommand(commentsManager, changeId);
        }),
        vscode.commands.registerCommand('jj-view.ackComment', async (reply?: vscode.CommentReply) => {
            await ackCommentCommand(commentsManager, reply);
        }),
        vscode.commands.registerCommand('jj-view.doneComment', async (reply?: vscode.CommentReply) => {
            await doneCommentCommand(commentsManager, reply);
        }),
        vscode.commands.registerCommand('jj-view.replyAndResolveComment', async (reply?: vscode.CommentReply) => {
            await replyAndResolveCommentCommand(commentsManager, reply);
        }),
        vscode.commands.registerCommand('jj-view.replyComment', async (reply?: vscode.CommentReply) => {
            await replyCommentCommand(commentsManager, reply);
        }),
        vscode.commands.registerCommand(
            'jj-view.resolveCommentThread',
            async (arg?: vscode.CommentThread | vscode.CommentReply) => {
                await resolveCommentThreadCommand(commentsManager, arg);
            },
        ),
        vscode.commands.registerCommand(
            'jj-view.unresolveCommentThread',
            async (arg?: vscode.CommentThread | vscode.CommentReply) => {
                await unresolveCommentThreadCommand(commentsManager, arg);
            },
        ),
        vscode.commands.registerCommand('jj-view.copyUnresolvedComments', async () => {
            await copyUnresolvedCommentsCommand(commentsManager);
        }),
    );

    context.subscriptions.push(
        registerWrappedCommand('jj-view.abandon', async (scm, jj, ...args) => {
            await abandonCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.restore', async (scm, jj, ...args) => {
            const states = args as vscode.SourceControlResourceState[];
            await restoreCommand(scm, jj, states);
        }),
        registerWrappedCommand('jj-view.squashRevisionIntoParent', async (scm, jj, ...args) => {
            await squashRevisionIntoParentCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.squashRevisionIntoAncestor', async (scm, jj, ...args) => {
            await squashRevisionIntoAncestorCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.completeSquashRevision', async (scm, jj) => {
            const storageDir = scm.getSquashStorageDir();
            const msgPath = path.join(storageDir, 'SQUASH_MSG');
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === msgPath);
            if (doc) {
                if (doc.isDirty) {
                    await doc.save();
                }
                await completeSquashRevisionCommand(scm, jj, doc.getText());
            }
        }),
        registerWrappedCommand('jj-view.setDescription', async (scm, jj, ...args) => {
            return await setDescriptionCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.squashSelectionIntoParent', async (scm, jj) => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await squashSelectionIntoParentCommand(scm, jj, editor);
            }
        }),
        registerWrappedCommand('jj-view.refresh', async (scm) => {
            await refreshCommand(scm);
        }),
        registerWrappedCommand('jj-view.openFile', async (_scm, _jj, ...args) => {
            await openFileCommand(...args);
        }),
        registerWrappedCommand('jj-view.openChanges', async (_scm, _jj, ...args) => {
            const state = args[0] as JjResourceState | undefined;
            await openChangesCommand(state);
        }),
        registerWrappedCommand('jj-view.undo', async (scm, jj) => {
            await undoCommand(scm, jj);
            await scm.repo.refresh({ reason: 'undo' });
        }),
        registerWrappedCommand('jj-view.redo', async (scm, jj) => {
            await redoCommand(scm, jj);
            await scm.repo.refresh({ reason: 'redo' });
        }),
        registerWrappedCommand('jj-view.duplicate', async (scm, jj, ...args) => {
            await duplicateCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.edit', async (scm, jj, ...args) => {
            await editCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.newBefore', async (scm, jj, ...args) => {
            const changeIds = args as string[];
            await newBeforeCommand(scm, jj, changeIds);
        }),
        registerWrappedCommand('jj-view.newAfter', async (scm, jj, ...args) => {
            const changeIds = args as string[];
            await newAfterCommand(scm, jj, changeIds);
        }),
        registerWrappedCommand('jj-view.upload', async (scm, jj, ...args) => {
            await uploadCommand(scm, jj, scm.repo.codeForge, args, outputChannel);
        }),
        registerWrappedCommand('jj-view.setBookmark', async (scm, jj, ...args) => {
            const arg = args[0] as { commitId: string };
            await setBookmarkCommand(scm, jj, arg);
        }),
        registerWrappedCommand('jj-view.advanceBookmark', async (scm, jj, ...args) => {
            await advanceBookmarkCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.advanceBookmarkAndUpload', async (scm, jj, ...args) => {
            await advanceBookmarkAndUploadCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.deleteBookmark', async (scm, jj, ...args) => {
            await deleteBookmarkCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.showDetails', async (_scm, jj, ...args) => {
            await showDetailsCommand(jj, outputChannel, args);
        }),
        registerWrappedCommand('jj-view.openMergeEditor', async (scm, _jj, ...args) => {
            const rest = args.slice(1);
            await openMergeEditorCommand(scm, args[0], ...rest);
        }),
        registerWrappedCommand('jj-view.absorb', async (scm, jj, ...args) => {
            await absorbCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.showMultiFileDiff', async (_scm, jj, ...args) => {
            await showMultiFileDiffCommand(jj, outputChannel, ...args);
        }),
        registerWrappedCommand('jj-view.compareWithWorkingCopy', async (_scm, jj, ...args) => {
            await compareAllFilesWithRevisionCommand(jj, outputChannel, ...args);
        }),
        registerWrappedCommand('jj-view.compareFileWith', async (_scm, jj, ...args) => {
            await compareFileWithRevisionCommand(jj, outputChannel, ...args);
        }),
        registerWrappedCommand('jj-view.viewFileAtRevision', async (_scm, jj, ...args) => {
            await viewFileAtRevisionCommand(jj, outputChannel, ...args);
        }),
        registerWrappedCommand('jj-view.workspaceAdd', async (scm, jj) => {
            await workspaceAddCommand(scm, jj);
        }),
        registerWrappedCommand('jj-view.workspaceForget', async (scm, jj, ...args) => {
            await workspaceForgetCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.workspaceDelete', async (scm, jj, ...args) => {
            await workspaceDeleteCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.workspaceOpenInCurrentWindow', async (scm, jj, ...args) => {
            await workspaceOpenInCurrentWindowCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.workspaceOpenInNewWindow', async (scm, jj, ...args) => {
            await workspaceOpenInNewWindowCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.discardChange', async (scm, _jj, ...args) => {
            const uri = args[0] as vscode.Uri;
            const changes = args[1];
            const index = args[2] as number;
            await discardChangeCommand(scm, uri, changes, index);
        }),
        registerWrappedCommand('jj-view.squashHunkIntoParent', async (scm, jj, ...args) => {
            const uri = args[0] as vscode.Uri;
            const changes = args[1];
            const index = args[2] as number;
            await squashHunkIntoParentCommand(scm, jj, uri, changes, index);
        }),
        registerWrappedCommand('jj-view.rebaseOntoSelected', async (scm, jj, ...args) => {
            const arg = args[0] as CommitMenuContext;
            await rebaseOntoSelectedCommand(scm, jj, arg);
        }),
        registerWrappedCommand('jj-view.squashFilesIntoParent', async (scm, jj, ...args) => {
            await squashFilesIntoParentCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.squashFilesIntoAncestor', async (scm, jj, ...args) => {
            await squashFilesIntoAncestorCommand(scm, jj, args);
        }),
        registerWrappedCommand('jj-view.squashFilesIntoChild', async (scm, jj, ...args) => {
            await squashFilesIntoChildCommand(scm, jj, args);
        }),
    );

    // Register log theme visibility actions
    for (const actionId of TOGGLEABLE_COMMIT_ACTIONS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`jj-view.hideCommitAction.${actionId}`, () =>
                logWebviewProvider.toggleActionVisibility(actionId),
            ),
            vscode.commands.registerCommand(`jj-view.toggleCommitAction.${actionId}.on`, () =>
                logWebviewProvider.toggleActionVisibility(actionId),
            ),
            vscode.commands.registerCommand(`jj-view.toggleCommitAction.${actionId}.off`, () =>
                logWebviewProvider.toggleActionVisibility(actionId),
            ),
        );
    }

    const refreshDisposable = vscode.commands.registerCommand('jj-view.refreshGraph', async () => {
        await logWebviewProvider.refresh();
    });
    context.subscriptions.push(refreshDisposable);

    const refreshCmd = vscode.commands.registerCommand('jj-view.refreshLog', () => logWebviewProvider.refresh());
    context.subscriptions.push(refreshCmd);

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
        registerCodeForgeProvider: (factory: CodeForgeProviderFactory) => codeForgeRegistry.register(factory),
    };
}

/** Checks if a terminal command is a jj upload or push and triggers staggered code forge refreshes. */
export function handleTerminalExecution(
    commandLine: string,
    codeForgeService: CodeForgeService,
    outputChannel: JjLoggerChannel,
    scmProvider: JjScmProvider,
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
