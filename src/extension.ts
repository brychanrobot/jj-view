/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

import { JjService } from './jj-service';
import { JjScmProvider } from './jj-scm-provider';
import { JjDocumentContentProvider } from './jj-content-provider';
import { JjLogWebviewProvider } from './jj-log-webview-provider';
import { GerritService } from './gerrit-service';
import { abandonCommand } from './commands/abandon';
import { newMergeChangeCommand, MergeCommandArg } from './commands/merge';
import { squashCommand, completeSquashCommand } from './commands/squash';
import { moveToChildCommand, moveToParentInDiffCommand, moveToChildInDiffCommand } from './commands/move';
import { restoreCommand } from './commands/restore';
import { setDescriptionCommand } from './commands/describe';
import { newCommand } from './commands/new';
import { uploadCommand } from './commands/upload';
import { discardChangeCommand } from './commands/discard-change';
import { squashChangeCommand } from './commands/squash-change';
import { setBookmarkCommand } from './commands/bookmark';
import { absorbCommand } from './commands/absorb';
import { newBeforeCommand } from './commands/new-before';

export interface Api {
    scmProvider: JjScmProvider;
    jj: JjService;
}

import { undoCommand } from './commands/undo';
import { duplicateCommand } from './commands/duplicate';
import { editCommand } from './commands/edit';
import { showDetailsCommand } from './commands/details';
import { showCurrentChangeCommand } from './commands/show';
import { commitCommand } from './commands/commit';
import { rebaseOntoSelectedCommand, CommitMenuContext } from './commands/rebase';
import { openMergeEditorCommand } from './commands/merge-editor';
import { refreshCommand } from './commands/refresh';
import { openFileCommand } from './commands/open';
import { showMultiFileDiffCommand } from './commands/multi-diff';

export function activate(context: vscode.ExtensionContext) {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const outputChannel = vscode.window.createOutputChannel('JJ View');
    context.subscriptions.push(outputChannel);

    const jj = new JjService(workspaceRoot, (msg) => outputChannel.appendLine(msg));
    const gerritService = new GerritService(workspaceRoot, jj, outputChannel);
    context.subscriptions.push(gerritService);

    const contentProvider = new JjDocumentContentProvider(jj);
    const scmProvider = new JjScmProvider(context, jj, workspaceRoot, outputChannel);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(scmProvider.decorationProvider));

    // Register Document Content Provider for read-only access to old file versions
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('jj-view', contentProvider));

    const disposable = vscode.commands.registerCommand('jj-view.showCurrentChange', async () => {
        await showCurrentChangeCommand(jj);
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
        vscode.commands.registerCommand('jj-view.squash', async (...args: unknown[]) => {
            await squashCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.completeSquash', async () => {
            await completeSquashCommand(scmProvider, jj);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.setDescription', async (messageArg?: string, revision?: string) => {
            const message = messageArg ?? scmProvider.sourceControl.inputBox.value;
            await setDescriptionCommand(scmProvider, jj, message, revision ? [revision] : undefined);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'jj-view.moveToChild',
            async (...resourceStates: vscode.SourceControlResourceState[]) => {
                await moveToChildCommand(scmProvider, jj, resourceStates);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.moveToParentInDiff', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await moveToParentInDiffCommand(scmProvider, jj, editor);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.moveToChildInDiff', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await moveToChildInDiffCommand(scmProvider, jj, editor);
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
        vscode.commands.registerCommand('jj-view.showDetails', async (arg: unknown) => {
            await showDetailsCommand(logWebviewProvider, [arg]);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.newBefore', async (...args: unknown[]) => {
            await newBeforeCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.upload', async (revision: string) => {
            await uploadCommand(scmProvider, jj, gerritService, revision);
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
        vscode.commands.registerCommand(
            'jj-view.squashChange',
            async (uri: vscode.Uri, changes: unknown, index: number) => {
                await squashChangeCommand(scmProvider, jj, uri, changes, index);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.setBookmark', async (arg: { commitId: string }) => {
            await setBookmarkCommand(scmProvider, jj, arg);
        }),
    );

    // Register view provider
    const logWebviewProvider = new JjLogWebviewProvider(context.extensionUri, jj, gerritService, (ids) => {
        scmProvider.handleSelectionChange(ids);
    }, outputChannel);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(JjLogWebviewProvider.viewType, logWebviewProvider),
    );

    const refreshDisposable = vscode.commands.registerCommand('jj-view.refreshGraph', async () => {
        await logWebviewProvider.refresh();
    });
    context.subscriptions.push(refreshDisposable);

    context.subscriptions.push(scmProvider);
    
    // Refresh tree immediately when SCM is ready (parallel to SCM view calculations)
    scmProvider.onRepoStateReady(() => logWebviewProvider.refresh());

    // For now, let's expose the refresh command to also refresh the tree
    const refreshCmd = vscode.commands.registerCommand('jj-view.refreshLog', () => logWebviewProvider.refresh());
    context.subscriptions.push(refreshCmd);

    const undoCmd = vscode.commands.registerCommand('jj-view.undo', async () => {
        await undoCommand(scmProvider, jj);
        await logWebviewProvider.refresh(); // Extra refresh for log
    });

    const rebaseOntoSelectedCmd = vscode.commands.registerCommand(
        'jj-view.rebaseOntoSelected',
        async (arg: CommitMenuContext) => {
            await rebaseOntoSelectedCommand(scmProvider, jj, arg);
        },
    );

    context.subscriptions.push(undoCmd);
    context.subscriptions.push(rebaseOntoSelectedCmd);

    context.subscriptions.push(disposable);
    context.subscriptions.push(newCmd);
    context.subscriptions.push(newMergeCommand);
    context.subscriptions.push(commitCmd);
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
            await showMultiFileDiffCommand(jj, ...args);
        }),
    );

    return {
        scmProvider,
        jj,
    };
}

// This method is called when your extension is deactivated
export function deactivate() {}
