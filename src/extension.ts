/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { JjScmProvider } from './jj-scm-provider';
import { JjDocumentContentProvider } from './jj-content-provider';
import { JjEditFileSystemProvider } from './jj-edit-fs-provider';
import { JjLogWebviewProvider } from './jj-log-webview-provider';
import { JjRepositoryManager, JjRepository } from './repository-manager';
import { JjService } from './jj-service';
import { GerritService } from './gerrit-service';
import { abandonCommand } from './commands/abandon';
import { newMergeChangeCommand, MergeCommandArg } from './commands/merge';
import { squashCommand, completeSquashCommand } from './commands/squash';
import { squashIntoCommand } from './commands/squash-into';
import { moveToChildCommand, moveToParentInDiffCommand } from './commands/move';
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
    repositoryManager: JjRepositoryManager;
    scmProvider?: JjScmProvider;
    jj?: JjService;
}

import { undoCommand } from './commands/undo';
import { duplicateCommand } from './commands/duplicate';
import { editCommand } from './commands/edit';
import { showDetailsCommand } from './commands/details';
import { showCurrentChangeCommand } from './commands/show';
import { commitCommand } from './commands/commit';
import { commitPromptCommand } from './commands/commit-prompt';
import { describePromptCommand } from './commands/describe-prompt';
import { rebaseOntoSelectedCommand, CommitMenuContext } from './commands/rebase';
import { openMergeEditorCommand } from './commands/merge-editor';
import { refreshCommand } from './commands/refresh';
import { openFileCommand } from './commands/open';
import { showMultiFileDiffCommand } from './commands/multi-diff';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('JJ View');
    context.subscriptions.push(outputChannel);

    let repositoryManager: JjRepositoryManager;

    const contentProvider = new JjDocumentContentProvider(
        (uri: vscode.Uri) => repositoryManager?.getRepository(uri)?.jj,
    );
    const editProvider = new JjEditFileSystemProvider((uri: vscode.Uri) => repositoryManager?.getRepository(uri)?.jj);

    repositoryManager = new JjRepositoryManager(context, outputChannel, contentProvider, editProvider);
    context.subscriptions.push(repositoryManager);

    // Wire up the edit provider to trigger scm refreshes
    editProvider.onDidWrite = () => repositoryManager.activeRepository?.scmProvider.refresh();

    // Register Document Content Provider for read-only access to old file versions
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('jj-view', contentProvider));

    // Register FileSystemProvider for editable access to mutable revision files
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('jj-edit', editProvider));

    // Scan initial repositories
    repositoryManager.scan();

    // Helper to register commands that operate on a JjRepository
    function registerRepoCommand(id: string, callback: (repo: JjRepository, ...args: unknown[]) => Promise<void>) {
        return vscode.commands.registerCommand(id, async (arg?: unknown, ...rest: unknown[]) => {
            const repo = repositoryManager.getRepository(arg);
            if (repo) {
                await callback(repo, arg, ...rest);
            }
        });
    }

    const logWebviewProvider = new JjLogWebviewProvider(
        context.extensionUri,
        repositoryManager,
        (ids) => {
            repositoryManager.activeRepository?.scmProvider.handleSelectionChange(ids);
        },
        outputChannel,
    );

    context.subscriptions.push(
        // Extension level commands.
        vscode.commands.registerCommand('jj-view.openFile', (resourceState: vscode.SourceControlResourceState) =>
            openFileCommand(resourceState),
        ),
        vscode.commands.registerCommand('jj-view.showDetails', (arg) => showDetailsCommand(logWebviewProvider, [arg])),
        vscode.commands.registerCommand('jj-view.refreshGraph', () => logWebviewProvider.refresh()),
        vscode.commands.registerCommand('jj-view.refreshLog', () => logWebviewProvider.refresh()),
        vscode.commands.registerCommand('jj-view.selectLogRepository', async () => {
            interface RepoQuickPickItem extends vscode.QuickPickItem {
                repo: JjRepository | undefined;
            }

            const activeRepo = repositoryManager.activeRepository;
            const activeRepoName = activeRepo ? path.basename(activeRepo.rootUri.fsPath) : '';

            const items: RepoQuickPickItem[] = [
                {
                    label: `$(sync) Auto${activeRepoName ? `: ${activeRepoName}` : ''}`,
                    description: 'Follow Active Editor',
                    repo: undefined,
                },
            ];

            for (const repo of repositoryManager.repositories) {
                const isSelected = logWebviewProvider.selectedRepository === repo;
                const matchesActive = repositoryManager.activeRepository === repo;

                items.push({
                    label: `$(repo) ${path.basename(repo.rootUri.fsPath)}`,
                    description: repo.rootUri.fsPath,
                    repo: repo,
                    detail: isSelected ? 'Currently pinned' : matchesActive ? 'Active Editor' : '',
                });
            }

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select repository to view log for',
            });

            if (selected !== undefined) {
                logWebviewProvider.setSelectedRepository(selected.repo);
            }
        }),

        // Repository level commands or those that operate on the current change.
        registerRepoCommand('jj-view.showCurrentChange', (repo) => showCurrentChangeCommand(repo.jj, outputChannel)),
        registerRepoCommand('jj-view.new', (repo, arg, ...rest) =>
            newCommand(repo.scmProvider, repo.jj, [arg, ...rest]),
        ),
        registerRepoCommand('jj-view.newMergeChange', (repo, arg) =>
            newMergeChangeCommand(repo.scmProvider, repo.jj, arg as MergeCommandArg),
        ),
        registerRepoCommand('jj-view.commit', (repo) => commitCommand(repo.scmProvider, repo.jj)),
        registerRepoCommand('jj-view.commitPrompt', (repo) => commitPromptCommand(repo.scmProvider, repo.jj)),
        registerRepoCommand('jj-view.describePrompt', (repo) => describePromptCommand(repo.scmProvider, repo.jj)),
        registerRepoCommand('jj-view.undo', (repo) =>
            undoCommand(repo.scmProvider, repo.jj).then(() => logWebviewProvider.refresh()),
        ),
        registerRepoCommand('jj-view.refresh', (repo) => refreshCommand(repo.scmProvider)),

        // Commands that operate on individual changes.
        registerRepoCommand('jj-view.edit', (repo, arg) => editCommand(repo.scmProvider, repo.jj, [arg])),
        registerRepoCommand('jj-view.duplicate', (repo, arg) => duplicateCommand(repo.scmProvider, repo.jj, [arg])),
        registerRepoCommand('jj-view.abandon', (repo, arg) => abandonCommand(repo.scmProvider, repo.jj, [arg])),
        registerRepoCommand('jj-view.restore', (repo, arg, ...rest) =>
            restoreCommand(repo.scmProvider, repo.jj, [arg, ...rest] as vscode.SourceControlResourceState[]),
        ),
        registerRepoCommand('jj-view.squash', (repo, arg, ...rest) =>
            squashCommand(repo.scmProvider, repo.jj, [arg, ...rest]),
        ),
        registerRepoCommand('jj-view.squashInto', (repo, arg, ...rest) =>
            squashIntoCommand(repo.scmProvider, repo.jj, [arg, ...rest]),
        ),
        registerRepoCommand('jj-view.completeSquash', (repo) => completeSquashCommand(repo.scmProvider, repo.jj)),
        registerRepoCommand('jj-view.setDescription', (repo, arg, ...rest) =>
            setDescriptionCommand(repo.scmProvider, repo.jj, [arg, ...rest]),
        ),
        registerRepoCommand('jj-view.moveToChild', (repo, arg, ...rest) =>
            moveToChildCommand(repo.scmProvider, repo.jj, [arg, ...rest] as vscode.SourceControlResourceState[]),
        ),
        registerRepoCommand('jj-view.newBefore', (repo, arg, ...rest) =>
            newBeforeCommand(repo.scmProvider, repo.jj, [arg, ...rest]),
        ),
        registerRepoCommand('jj-view.upload', (repo, arg, ...rest) =>
            uploadCommand(repo.jj, repo.gerritService, [arg, ...rest], outputChannel),
        ),
        registerRepoCommand('jj-view.discardChange', (repo, arg: unknown, changes: unknown, index: unknown) =>
            discardChangeCommand(repo.scmProvider, arg as vscode.Uri, changes, index as number),
        ),
        registerRepoCommand('jj-view.squashChange', (repo, arg: unknown, changes: unknown, index: unknown) =>
            squashChangeCommand(repo.scmProvider, repo.jj, arg as vscode.Uri, changes, index as number),
        ),
        registerRepoCommand('jj-view.setBookmark', (repo, arg: unknown) =>
            setBookmarkCommand(repo.scmProvider, repo.jj, arg as { commitId: string }),
        ),
        registerRepoCommand('jj-view.rebaseOntoSelected', (repo, arg: unknown) =>
            rebaseOntoSelectedCommand(repo.scmProvider, repo.jj, arg as CommitMenuContext),
        ),
        registerRepoCommand('jj-view.openMergeEditor', (repo, arg, ...rest) =>
            openMergeEditorCommand(repo.scmProvider, arg, ...rest),
        ),
        registerRepoCommand('jj-view.absorb', (repo, arg, ...rest) =>
            absorbCommand(repo.scmProvider, repo.jj, [arg, ...rest]),
        ),

        // Diff related commands.
        registerRepoCommand('jj-view.moveToParentInDiff', (repo) => {
            const editor = vscode.window.activeTextEditor;
            return editor ? moveToParentInDiffCommand(repo.scmProvider, repo.jj, editor) : Promise.resolve();
        }),
        registerRepoCommand('jj-view.showMultiFileDiff', (repo, arg, ...rest) =>
            showMultiFileDiffCommand(repo.jj, outputChannel, ...[arg, ...rest]),
        ),

        // Register log webview view provider.
        vscode.window.registerWebviewViewProvider(JjLogWebviewProvider.viewType, logWebviewProvider),
    );

    return {
        repositoryManager,
        get scmProvider() {
            return repositoryManager.activeRepository?.scmProvider;
        },
        get jj() {
            return repositoryManager.activeRepository?.jj;
        },
    };
}

/** Checks if a terminal command is a jj upload and triggers staggered Gerrit refreshes. */
export function handleTerminalExecution(
    commandLine: string,
    gerritService: GerritService,
    outputChannel: vscode.OutputChannel,
): boolean {
    const cmd = commandLine.trim();
    if (cmd.startsWith('jj') && cmd.includes('upload')) {
        outputChannel.appendLine(`[Extension] Detected terminal upload: "${cmd}"`);
        gerritService.requestRefreshWithBackoffs();
        return true;
    }
    return false;
}

// This method is called when your extension is deactivated
export function deactivate() {}
