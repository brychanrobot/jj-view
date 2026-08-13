/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { abandonCommand } from '../commands/abandon';
import { absorbCommand } from '../commands/absorb';
import { setBookmarkCommand } from '../commands/bookmark';
import { advanceBookmarkCommand } from '../commands/bookmark-advance';
import { advanceBookmarkAndUploadCommand } from '../commands/bookmark-advance-upload';
import { deleteBookmarkCommand } from '../commands/bookmark-delete';
import { resolveRepository } from '../commands/command-utils';
import {
    ackCommentCommand,
    copyUnresolvedCommentsCommand,
    doneCommentCommand,
    replyAndResolveCommentCommand,
    replyCommentCommand,
    resolveCommentThreadCommand,
    showCommentsCommand,
    unresolveCommentThreadCommand,
} from '../commands/comments';
import { commitCommand } from '../commands/commit';
import { commitPromptCommand } from '../commands/commit-prompt';
import { compareAllFilesWithRevisionCommand } from '../commands/compare-all-files-with-revision';
import { compareFileWithRevisionCommand } from '../commands/compare-file-with-revision';
import { setDescriptionCommand } from '../commands/describe';
import { describePromptCommand } from '../commands/describe-prompt';
import { showDetailsCommand } from '../commands/details';
import { discardChangeCommand } from '../commands/discard-change';
import { duplicateCommand } from '../commands/duplicate';
import { editCommand } from '../commands/edit';
import { focusDescriptionInputCommand } from '../commands/focus-description-input';
import { type MergeCommandArg, newMergeChangeCommand } from '../commands/merge';
import { openMergeEditorCommand } from '../commands/merge-editor';
import { showMultiFileDiffCommand } from '../commands/multi-diff';
import { newCommand } from '../commands/new';
import { newAfterCommand } from '../commands/new-after';
import { newBeforeCommand } from '../commands/new-before';
import { openChangesCommand, openFileCommand } from '../commands/open';
import { type CommitMenuContext, rebaseOntoSelectedCommand } from '../commands/rebase';
import { redoCommand } from '../commands/redo';
import { refreshCommand } from '../commands/refresh';
import { restoreCommand } from '../commands/restore';
import {
    squashFilesIntoAncestorCommand,
    squashFilesIntoChildCommand,
    squashFilesIntoParentCommand,
} from '../commands/squash-files';
import {
    completeSquashRevisionCommand,
    getSquashStorageDir,
    squashRevisionIntoAncestorCommand,
    squashRevisionIntoParentCommand,
} from '../commands/squash-revision';
import { squashHunkIntoParentCommand, squashSelectionIntoParentCommand } from '../commands/squash-selection';
import { undoCommand } from '../commands/undo';
import { uploadCommand } from '../commands/upload';
import { viewFileAtRevisionCommand } from '../commands/view-file-at-revision';
import { workspaceAddCommand } from '../commands/workspace-add';
import { workspaceDeleteCommand } from '../commands/workspace-delete';
import { workspaceForgetCommand } from '../commands/workspace-forget';
import { workspaceOpenInCurrentWindowCommand, workspaceOpenInNewWindowCommand } from '../commands/workspace-open';
import type { CommentsManager } from '../comments-manager';
import type { CommandContext } from '../common/command-context';
import type { JjLogWebviewProvider } from '../jj-log-webview-provider';
import type { JjRepositoryManager } from '../jj-repository-manager';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';

import { TOGGLEABLE_COMMIT_ACTIONS } from '../jj-types';
import type { JjResourceState } from '../scm-resource-state';
import type { Uri } from '../uri-utils';
import type { JjLoggerChannel } from '../utils/output-channel';
import { createAbandonPayload } from './payloads/abandon.payload';
import { createSetBookmarkPayload } from './payloads/bookmark.payload';
import { createAdvanceBookmarkPayload } from './payloads/bookmark-advance.payload';
import { createAdvanceBookmarkAndUploadPayload } from './payloads/bookmark-advance-upload.payload';
import { createDeleteBookmarkPayload } from './payloads/bookmark-delete.payload';
import { createCommitPayload } from './payloads/commit.payload';
import { createSetDescriptionPayload } from './payloads/describe.payload';
import { createDuplicatePayload } from './payloads/duplicate.payload';
import { createEditPayload } from './payloads/edit.payload';
import { createNewPayload } from './payloads/new.payload';
import { createRestorePayload } from './payloads/restore.payload';
import {
    createSquashFilesIntoAncestorPayload,
    createSquashFilesIntoChildPayload,
    createSquashFilesIntoParentPayload,
} from './payloads/squash-files.payload';
import {
    createSquashRevisionIntoAncestorPayload,
    createSquashRevisionIntoParentPayload,
} from './payloads/squash-revision.payload';
import {
    createSquashHunkIntoParentPayload,
    createSquashSelectionIntoParentPayload,
} from './payloads/squash-selection.payload';
import { VSCodeCommandContext } from './vscode-command-context';

export interface RegisterCommandsOptions {
    context: vscode.ExtensionContext;
    repositoryManager: JjRepositoryManager;
    scmProviders: Map<string, JjScmProvider>;
    outputChannel: JjLoggerChannel;
    commentsManager: CommentsManager;
    logWebviewProvider: JjLogWebviewProvider;
}

export function registerVSCodeCommands(options: RegisterCommandsOptions): void {
    const { context, repositoryManager, scmProviders, outputChannel, commentsManager, logWebviewProvider } = options;

    const resolveRepositoryLocal = (args: unknown[]) => resolveRepository(args, repositoryManager, scmProviders);

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

    function registerCommandWithPayload<TPayload, TReturn = unknown>(
        commandId: string,
        payloadCreator: (args: unknown[], scm?: JjScmProvider) => TPayload,
        handler: (ctx: CommandContext, payload: TPayload) => Promise<TReturn>,
    ): vscode.Disposable {
        return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
            const context = resolveRepositoryLocal(args);
            if (context) {
                repositoryManager.setFocusedRepository(context.repo);
                const cmdCtx = new VSCodeCommandContext(context.repo, outputChannel, commentsManager);
                const payload = payloadCreator(args, context.scm);
                return await handler(cmdCtx, payload);
            } else {
                outputChannel.error(`[Command Error] Failed to resolve repository for command: ${commandId}`);
                return;
            }
        });
    }

    function registerCommand<TReturn = unknown>(
        commandId: string,
        handler: (ctx: CommandContext) => Promise<TReturn>,
    ): vscode.Disposable {
        return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
            const context = resolveRepositoryLocal(args);
            if (context) {
                repositoryManager.setFocusedRepository(context.repo);
                const cmdCtx = new VSCodeCommandContext(context.repo, outputChannel, commentsManager);
                return await handler(cmdCtx);
            } else {
                outputChannel.error(`[Command Error] Failed to resolve repository for command: ${commandId}`);
                return;
            }
        });
    }
    context.subscriptions.push(
        registerWrappedCommand('jj-view.focusRepository', () => {
            // No-op: registerWrappedCommand automatically resolves the clicked repository's rootUri and sets it as the focused repository.
        }),
        registerCommandWithPayload('jj-view.new', createNewPayload, newCommand),
        registerWrappedCommand('jj-view.newMergeChange', async (scm, jj, ...args) => {
            const arg = args[0] as MergeCommandArg | undefined;
            await newMergeChangeCommand(scm, jj, arg);
        }),
        registerCommandWithPayload('jj-view.commit', createCommitPayload, commitCommand),
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
        registerCommandWithPayload('jj-view.abandon', createAbandonPayload, abandonCommand),
        registerCommandWithPayload('jj-view.restore', createRestorePayload, restoreCommand),
        registerCommandWithPayload(
            'jj-view.squashRevisionIntoParent',
            createSquashRevisionIntoParentPayload,
            squashRevisionIntoParentCommand,
        ),
        registerCommandWithPayload(
            'jj-view.squashRevisionIntoAncestor',
            createSquashRevisionIntoAncestorPayload,
            squashRevisionIntoAncestorCommand,
        ),
        registerCommand('jj-view.completeSquashRevision', async (ctx) => {
            const storageDir = getSquashStorageDir(ctx.repo.rootUri.fsPath);
            const msgPath = path.join(storageDir, 'SQUASH_MSG');
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === msgPath);
            if (doc) {
                if (doc.isDirty) {
                    await doc.save();
                }
                await completeSquashRevisionCommand(ctx, doc.getText());
            }
        }),
        registerCommandWithPayload('jj-view.setDescription', createSetDescriptionPayload, setDescriptionCommand),
        registerCommandWithPayload(
            'jj-view.squashSelectionIntoParent',
            () => createSquashSelectionIntoParentPayload(vscode.window.activeTextEditor),
            squashSelectionIntoParentCommand,
        ),
        registerCommand('jj-view.refresh', refreshCommand),
        registerWrappedCommand('jj-view.openFile', async (_scm, _jj, ...args) => {
            await openFileCommand(...args);
        }),
        registerWrappedCommand('jj-view.openChanges', async (_scm, _jj, ...args) => {
            const state = args[0] as JjResourceState | undefined;
            await openChangesCommand(state);
        }),
        registerCommand('jj-view.undo', undoCommand),
        registerCommand('jj-view.redo', redoCommand),
        registerCommandWithPayload('jj-view.duplicate', createDuplicatePayload, duplicateCommand),
        registerCommandWithPayload('jj-view.edit', createEditPayload, editCommand),
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
        registerCommandWithPayload('jj-view.setBookmark', createSetBookmarkPayload, setBookmarkCommand),
        registerCommandWithPayload('jj-view.advanceBookmark', createAdvanceBookmarkPayload, advanceBookmarkCommand),
        registerCommandWithPayload(
            'jj-view.advanceBookmarkAndUpload',
            createAdvanceBookmarkAndUploadPayload,
            (ctx, payload) => advanceBookmarkAndUploadCommand(ctx, payload, scmProviders.get(ctx.repo.rootUri.fsPath)),
        ),
        registerCommandWithPayload('jj-view.deleteBookmark', createDeleteBookmarkPayload, deleteBookmarkCommand),
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
            const uri = args[0] as Uri;
            const changes = args[1];
            const index = args[2] as number;
            await discardChangeCommand(scm, uri, changes, index);
        }),
        registerCommandWithPayload(
            'jj-view.squashHunkIntoParent',
            createSquashHunkIntoParentPayload,
            squashHunkIntoParentCommand,
        ),
        registerWrappedCommand('jj-view.rebaseOntoSelected', async (scm, jj, ...args) => {
            const arg = args[0] as CommitMenuContext;
            await rebaseOntoSelectedCommand(scm, jj, arg);
        }),
        registerCommandWithPayload(
            'jj-view.squashFilesIntoParent',
            createSquashFilesIntoParentPayload,
            squashFilesIntoParentCommand,
        ),
        registerCommandWithPayload(
            'jj-view.squashFilesIntoAncestor',
            createSquashFilesIntoAncestorPayload,
            squashFilesIntoAncestorCommand,
        ),
        registerCommandWithPayload(
            'jj-view.squashFilesIntoChild',
            createSquashFilesIntoChildPayload,
            squashFilesIntoChildCommand,
        ),
    );

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
}
