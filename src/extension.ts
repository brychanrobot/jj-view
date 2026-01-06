// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';

import { JjService } from './jj-service';
import { JjScmProvider } from './jj-scm-provider';
import { JjDocumentContentProvider } from './jj-content-provider';
import { JjLogWebviewProvider } from './jj-log-webview-provider';
import { abandonCommand } from './commands/abandon';
import { newMergeChangeCommand, MergeCommandArg } from './commands/merge';
import { squashCommand, completeSquashCommand } from './commands/squash';
import { moveToChildCommand, moveToParentInDiffCommand, moveToChildInDiffCommand } from './commands/move';
import { restoreCommand } from './commands/restore';
import { setDescriptionCommand } from './commands/describe';
import { newCommand } from './commands/new';

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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    // console.log('Congratulations, your extension "good-juju" is now active!');

    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const outputChannel = vscode.window.createOutputChannel('Good Juju');
    context.subscriptions.push(outputChannel);

    const jj = new JjService(workspaceRoot);
    const contentProvider = new JjDocumentContentProvider(jj);
    const scmProvider = new JjScmProvider(context, jj, workspaceRoot, outputChannel);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(scmProvider.decorationProvider));

    // Register Document Content Provider for read-only access to old file versions
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('good-juju', contentProvider));

    const disposable = vscode.commands.registerCommand('good-juju.showCurrentChange', async () => {
        await showCurrentChangeCommand(jj);
    });

    const newCmd = vscode.commands.registerCommand('good-juju.new', async (...args: unknown[]) => {
        await newCommand(scmProvider, jj, args);
    });

    const newMergeCommand = vscode.commands.registerCommand(
        'good-juju.newMergeChange',
        async (arg: MergeCommandArg | undefined) => {
            await newMergeChangeCommand(scmProvider, jj, arg);
        },
    );

    const commitCmd = vscode.commands.registerCommand('good-juju.commit', async () => {
        await commitCommand(scmProvider, jj);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.abandon', async (arg: unknown) => {
            await abandonCommand(scmProvider, jj, [arg]);
        }),
        vscode.commands.registerCommand(
            'good-juju.restore',
            async (...resourceStates: vscode.SourceControlResourceState[]) => {
                await restoreCommand(scmProvider, jj, resourceStates);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.squash', async (...args: unknown[]) => {
            await squashCommand(scmProvider, jj, args);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.completeSquash', async () => {
            await completeSquashCommand(scmProvider, jj);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.setDescription', async () => {
            const message = scmProvider.sourceControl.inputBox.value;
            await setDescriptionCommand(scmProvider, jj, message);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'good-juju.moveToChild',
            async (...resourceStates: vscode.SourceControlResourceState[]) => {
                await moveToChildCommand(scmProvider, jj, resourceStates);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.moveToParentInDiff', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await moveToParentInDiffCommand(scmProvider, jj, editor);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.moveToChildInDiff', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await moveToChildInDiffCommand(scmProvider, jj, editor);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.refresh', async () => {
            await refreshCommand(scmProvider);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'good-juju.openFile',
            async (resourceState: vscode.SourceControlResourceState) => {
                await openFileCommand(resourceState);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.duplicate', async (arg: unknown) => {
            await duplicateCommand(scmProvider, jj, [arg]);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.edit', async (arg: unknown) => {
            await editCommand(scmProvider, jj, [arg]);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.showDetails', async (arg: unknown) => {
            await showDetailsCommand(logWebviewProvider, [arg]);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('good-juju.newBefore', async () => {
            vscode.window.showInformationMessage('New before not implemented yet');
        }),
    );

    // Initialize provider
    const logWebviewProvider = new JjLogWebviewProvider(context.extensionUri, jj, (ids) => {
        scmProvider.handleSelectionChange(ids);
    });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(JjLogWebviewProvider.viewType, logWebviewProvider),
    );

    // Make the provider accessible for refresh if possible or listen to an event.
    // Integrating refresh:
    const refreshDisposable = vscode.commands.registerCommand('good-juju.refreshGraph', async () => {
        await logWebviewProvider.refresh();
    });
    context.subscriptions.push(refreshDisposable);

    context.subscriptions.push(scmProvider);

    // Refresh tree when SCM refreshes
    scmProvider.onDidChangeStatus(() => logWebviewProvider.refresh());

    // For now, let's expose the refresh command to also refresh the tree
    const refreshCmd = vscode.commands.registerCommand('good-juju.refreshLog', () => logWebviewProvider.refresh());
    context.subscriptions.push(refreshCmd);

    const undoCmd = vscode.commands.registerCommand('good-juju.undo', async () => {
        await undoCommand(scmProvider, jj);
        await logWebviewProvider.refresh(); // Extra refresh for log
    });

    const rebaseOntoSelectedCmd = vscode.commands.registerCommand(
        'good-juju.rebaseOntoSelected',
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
        vscode.commands.registerCommand('good-juju.openMergeEditor', async (arg: unknown, ...rest: unknown[]) => {
            await openMergeEditorCommand(scmProvider, arg, ...rest);
        }),
    );

    return {
        scmProvider,
        jj,
    };
}

// This method is called when your extension is deactivated
export function deactivate() {}
