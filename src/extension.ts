/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { abandonCommand } from './commands/abandon';
import { absorbCommand } from './commands/absorb';
import { setBookmarkCommand } from './commands/bookmark';
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
import { type MergeCommandArg, newMergeChangeCommand } from './commands/merge';
import { openMergeEditorCommand } from './commands/merge-editor';
import { showMultiFileDiffCommand } from './commands/multi-diff';
import { newCommand } from './commands/new';
import { newAfterCommand } from './commands/new-after';
import { newBeforeCommand } from './commands/new-before';
import { openChangesCommand, openFileCommand } from './commands/open';
import { type CommitMenuContext, rebaseOntoSelectedCommand } from './commands/rebase';
import { redoCommand } from './commands/redo';
import { refreshCommand } from './commands/refresh';
import { restoreCommand } from './commands/restore';
import { showCurrentChangeCommand } from './commands/show';
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
import { workspaceAddCommand } from './commands/workspace-add';
import { workspaceDeleteCommand } from './commands/workspace-delete';
import { workspaceForgetCommand } from './commands/workspace-forget';
import { GerritService } from './gerrit-service';
import { checkGitColocation } from './git-colocation';
import { JjCommitDetailsEditorProvider } from './jj-commit-details-editor-provider';
import { JjContextKey } from './jj-context-keys';
import { JjEditFileSystemProvider } from './jj-edit-fs-provider';
import { JjLogWebviewProvider } from './jj-log-webview-provider';
import { type JjResourceState, JjScmProvider } from './jj-scm-provider';
import { JjService } from './jj-service';
import { TOGGLEABLE_COMMIT_ACTIONS } from './jj-types';
import { JjViewFileSystemProvider } from './jj-view-fs-provider';
import { resolveJjBinary } from './utils/binary-utils';

export interface Api {
    scmProvider: JjScmProvider;
    jj: JjService;
}

export function activate(context: vscode.ExtensionContext) {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const outputChannel = vscode.window.createOutputChannel('JJ View');
    context.subscriptions.push(outputChannel);

    const jj = new JjService(workspaceRoot, (msg) => outputChannel.appendLine(msg));

    // Resolve jj binary path and handle failure
    const updateBinaryPath = async () => {
        const config = vscode.workspace.getConfiguration('jj-view');
        const preferredPath = config.get<string>('binaryPath');

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
            jj.binaryPath = resolvedPath;
            outputChannel.appendLine(`[Extension] Using jj binary at: ${resolvedPath}`);
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

    updateBinaryPath();

    const setOpenDiffOnClickContext = () => {
        const value = vscode.workspace.getConfiguration('jj-view').get<boolean>('openDiffOnClick', true);
        vscode.commands.executeCommand('setContext', JjContextKey.OpenDiffOnClick, value);
    };
    setOpenDiffOnClickContext();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('jj-view.binaryPath')) {
                await updateBinaryPath();
                scmProvider.refresh();
            }
            if (e.affectsConfiguration('jj-view.openDiffOnClick')) {
                setOpenDiffOnClickContext();
                scmProvider.refresh();
            }
        }),
    );

    const gerritService = new GerritService(workspaceRoot, jj, outputChannel);
    context.subscriptions.push(gerritService);

    const viewFileSystemProvider = new JjViewFileSystemProvider(jj);
    const editProvider = new JjEditFileSystemProvider(jj);
    const scmProvider = new JjScmProvider(
        context,
        jj,
        workspaceRoot,
        outputChannel,
        viewFileSystemProvider,
        editProvider,
    );

    // Wire up the edit provider to trigger scm refreshes
    editProvider.onDidWrite = () => scmProvider.refresh();

    context.subscriptions.push(vscode.window.registerFileDecorationProvider(scmProvider.decorationProvider));

    // Register FileSystemProvider for read-only access to old file versions (for diffs)
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('jj-view', viewFileSystemProvider, { isReadonly: true }),
    );

    // Register FileSystemProvider for editable access to mutable revision files
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('jj-edit', editProvider));

    const disposable = vscode.commands.registerCommand('jj-view.showCurrentChange', async () => {
        await showCurrentChangeCommand(jj, outputChannel);
    });

    const newCmd = vscode.commands.registerCommand('jj-view.new', async (...args: unknown[]) => {
        await newCommand(scmProvider, jj, args);
    });

    const newMergeCommand = vscode.commands.registerCommand(
        'jj-view.newMergeChange',
        async (arg: MergeCommandArg | undefined) => {
            await newMergeChangeCommand(scmProvider, jj, arg);
        },
    );

    const commitCmd = vscode.commands.registerCommand('jj-view.commit', async () => {
        await commitCommand(scmProvider, jj);
    });

    const commitPromptCmd = vscode.commands.registerCommand('jj-view.commitPrompt', async () => {
        await commitPromptCommand(scmProvider, jj);
    });

    const describePromptCmd = vscode.commands.registerCommand('jj-view.describePrompt', async () => {
        await describePromptCommand(scmProvider, jj);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.abandon', async (arg: unknown) => {
            await abandonCommand(scmProvider, jj, [arg]);
        }),
        vscode.commands.registerCommand(
            'jj-view.restore',
            async (...resourceStates: vscode.SourceControlResourceState[]) => {
                await restoreCommand(scmProvider, jj, resourceStates);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.squashRevisionIntoParent', async (...args: unknown[]) => {
            await squashRevisionIntoParentCommand(scmProvider, jj, args);
        }),
        vscode.commands.registerCommand('jj-view.squashRevisionIntoAncestor', async (...args: unknown[]) => {
            await squashRevisionIntoAncestorCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.completeSquashRevision', async () => {
            const storageDir = scmProvider.getSquashStorageDir();
            const msgPath = path.join(storageDir, 'SQUASH_MSG');
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === msgPath);
            if (doc) {
                if (doc.isDirty) {
                    await doc.save();
                }
                await completeSquashRevisionCommand(scmProvider, jj, doc.getText());
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.setDescription', (...args: unknown[]) =>
            setDescriptionCommand(scmProvider, jj, args),
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.squashSelectionIntoParent', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await squashSelectionIntoParentCommand(scmProvider, jj, editor);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.refresh', async () => {
            await refreshCommand(scmProvider);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'jj-view.openFile',
            async (resourceState: vscode.SourceControlResourceState) => {
                await openFileCommand(resourceState);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.openChanges', async (resourceState: JjResourceState) => {
            await openChangesCommand(resourceState);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'jj-view.squashHunkIntoParent',
            async (uri: vscode.Uri, changes: unknown, index: number) => {
                await squashHunkIntoParentCommand(scmProvider, jj, uri, changes, index);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.squashFilesIntoParent', async (...args: unknown[]) => {
            await squashFilesIntoParentCommand(scmProvider, jj, args);
        }),
        vscode.commands.registerCommand('jj-view.squashFilesIntoChild', async (...args: unknown[]) => {
            await squashFilesIntoChildCommand(scmProvider, jj, args);
        }),
        vscode.commands.registerCommand('jj-view.squashFilesIntoAncestor', async (...args: unknown[]) => {
            await squashFilesIntoAncestorCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.duplicate', async (arg: unknown) => {
            await duplicateCommand(scmProvider, jj, [arg]);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.edit', async (arg: unknown) => {
            await editCommand(scmProvider, jj, [arg]);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.newBefore', async (...args: unknown[]) => {
            await newBeforeCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.newAfter', async (...args: unknown[]) => {
            await newAfterCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.upload', async (...args: unknown[]) => {
            await uploadCommand(scmProvider, jj, gerritService, args, outputChannel);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'jj-view.discardChange',
            async (uri: vscode.Uri, changes: unknown, index: number) => {
                await discardChangeCommand(scmProvider, uri, changes, index);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.setBookmark', async (arg: { commitId: string }) => {
            await setBookmarkCommand(scmProvider, jj, arg);
        }),
    );

    const commitDetailsProvider = new JjCommitDetailsEditorProvider(context.extensionUri, jj);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(JjCommitDetailsEditorProvider.viewType, commitDetailsProvider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
    );

    // Register view provider
    const logWebviewProvider = new JjLogWebviewProvider(
        context.extensionUri,
        jj,
        gerritService,
        commitDetailsProvider,
        (ids) => {
            scmProvider.handleSelectionChange(ids);
        },
        context,
        outputChannel,
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(JjLogWebviewProvider.viewType, logWebviewProvider),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.showDetails', async (arg: unknown) => {
            await showDetailsCommand(logWebviewProvider, [arg]);
        }),
    );

    const refreshDisposable = vscode.commands.registerCommand('jj-view.refreshGraph', async () => {
        await logWebviewProvider.refresh();
    });
    context.subscriptions.push(refreshDisposable);

    context.subscriptions.push(scmProvider);

    // Refresh tree immediately when SCM is ready (parallel to SCM view calculations)
    scmProvider.onRepoStateReady(() => logWebviewProvider.refresh());

    // Detect terminal 'jj upload' commands and trigger immediate Gerrit refresh
    context.subscriptions.push(
        vscode.window.onDidEndTerminalShellExecution((event) => {
            handleTerminalExecution(event.execution.commandLine.value, gerritService, outputChannel, scmProvider);
        }),
    );

    // For now, let's expose the refresh command to also refresh the tree
    const refreshCmd = vscode.commands.registerCommand('jj-view.refreshLog', () => logWebviewProvider.refresh());
    context.subscriptions.push(refreshCmd);

    const undoCmd = vscode.commands.registerCommand('jj-view.undo', async () => {
        await undoCommand(scmProvider, jj);
        await logWebviewProvider.refresh(); // Extra refresh for log
    });

    const redoCmd = vscode.commands.registerCommand('jj-view.redo', async () => {
        await redoCommand(scmProvider, jj);
        await logWebviewProvider.refresh(); // Extra refresh for log
    });

    const rebaseOntoSelectedCmd = vscode.commands.registerCommand(
        'jj-view.rebaseOntoSelected',
        async (arg: CommitMenuContext) => {
            await rebaseOntoSelectedCommand(scmProvider, jj, arg);
        },
    );

    context.subscriptions.push(undoCmd);
    context.subscriptions.push(redoCmd);
    context.subscriptions.push(rebaseOntoSelectedCmd);

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

    context.subscriptions.push(disposable);
    context.subscriptions.push(newCmd);
    context.subscriptions.push(newMergeCommand);
    context.subscriptions.push(commitCmd);
    context.subscriptions.push(commitPromptCmd);
    context.subscriptions.push(describePromptCmd);
    context.subscriptions.push(scmProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.openMergeEditor', async (arg: unknown, ...rest: unknown[]) => {
            await openMergeEditorCommand(scmProvider, arg, ...rest);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.absorb', async (...args: unknown[]) => {
            await absorbCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.showMultiFileDiff', async (...args: unknown[]) => {
            await showMultiFileDiffCommand(jj, outputChannel, ...args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.compareWithWorkingCopy', async (...args: unknown[]) => {
            await compareAllFilesWithRevisionCommand(jj, outputChannel, ...args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.compareFileWith', async (...args: unknown[]) => {
            await compareFileWithRevisionCommand(jj, outputChannel, ...args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.workspaceAdd', async () => {
            await workspaceAddCommand(scmProvider, jj);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.workspaceForget', async (...args: unknown[]) => {
            await workspaceForgetCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.workspaceDelete', async (...args: unknown[]) => {
            await workspaceDeleteCommand(scmProvider, jj, args);
        }),
    );

    // Fire and forget: check if we should warn about git colocation
    checkGitColocation(jj).catch((e) => outputChannel.appendLine(`[Extension] Colocation check failed: ${e}`));

    return {
        scmProvider,
        jj,
    };
}

/** Checks if a terminal command is a jj upload and triggers staggered Gerrit refreshes. */
export function handleTerminalExecution(
    commandLine: string,
    gerritService: GerritService,
    outputChannel: vscode.OutputChannel,
    scmProvider: JjScmProvider,
): boolean {
    const cmd = commandLine.trim();
    if (cmd.startsWith('jj') && cmd.includes('upload')) {
        outputChannel.appendLine(`[Extension] Detected terminal upload: "${cmd}"`);
        gerritService.requestRefreshWithBackoffs();
        scmProvider.refresh();
        return true;
    }
    return false;
}

// This method is called when your extension is deactivated
export function deactivate() {}
