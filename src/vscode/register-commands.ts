/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { abandonCommand } from '../core/commands/abandon';
import { absorbCommand } from '../core/commands/absorb';
import { setBookmarkCommand } from '../core/commands/bookmark';
import { advanceBookmarkCommand } from '../core/commands/bookmark-advance';
import { advanceBookmarkAndUploadCommand } from '../core/commands/bookmark-advance-upload';
import { deleteBookmarkCommand } from '../core/commands/bookmark-delete';
import {
    ackCommentCommand,
    copyUnresolvedCommentsCommand,
    doneCommentCommand,
    replyAndResolveCommentCommand,
    replyCommentCommand,
    resolveCommentThreadCommand,
    showCommentsCommand,
    unresolveCommentThreadCommand,
} from '../core/commands/comments';
import { commitCommand } from '../core/commands/commit';
import { commitPromptCommand } from '../core/commands/commit-prompt';
import { compareAllFilesWithRevisionCommand } from '../core/commands/compare-all-files-with-revision';
import { compareFileWithRevisionCommand } from '../core/commands/compare-file-with-revision';
import { setDescriptionCommand } from '../core/commands/describe';
import { describePromptCommand } from '../core/commands/describe-prompt';
import { showDetailsCommand } from '../core/commands/details';
import { discardChangeCommand } from '../core/commands/discard-change';
import { duplicateCommand } from '../core/commands/duplicate';
import { editCommand } from '../core/commands/edit';
import { newMergeChangeCommand } from '../core/commands/merge';
import { openMergeEditorCommand } from '../core/commands/merge-editor';
import { showMultiFileDiffCommand } from '../core/commands/multi-diff';
import { newCommand } from '../core/commands/new';
import { newAfterCommand } from '../core/commands/new-after';
import { newBeforeCommand } from '../core/commands/new-before';
import { openChangesCommand, openFileCommand } from '../core/commands/open';
import { rebaseOntoSelectedCommand } from '../core/commands/rebase';
import { redoCommand } from '../core/commands/redo';
import { refreshCommand } from '../core/commands/refresh';
import { restoreCommand } from '../core/commands/restore';
import {
    squashFilesIntoAncestorCommand,
    squashFilesIntoChildCommand,
    squashFilesIntoParentCommand,
} from '../core/commands/squash-files';
import {
    completeSquashRevisionCommand,
    squashRevisionIntoAncestorCommand,
    squashRevisionIntoParentCommand,
} from '../core/commands/squash-revision';
import { squashHunkIntoParentCommand, squashSelectionIntoParentCommand } from '../core/commands/squash-selection';
import { undoCommand } from '../core/commands/undo';
import { uploadCommand } from '../core/commands/upload';
import { viewFileAtRevisionCommand } from '../core/commands/view-file-at-revision';
import { workspaceAddCommand } from '../core/commands/workspace-add';
import { workspaceDeleteCommand } from '../core/commands/workspace-delete';
import { workspaceForgetCommand } from '../core/commands/workspace-forget';
import { workspaceOpenInCurrentWindowCommand, workspaceOpenInNewWindowCommand } from '../core/commands/workspace-open';
import type { CommentsManager } from '../core/comments-manager';
import type { CommandContext } from '../core/host/command-context';
import { TOGGLEABLE_COMMIT_ACTIONS } from '../core/host/ipc/log-view-schemas';
import { resolveRepository } from '../core/host/ui-helpers';
import type { JjRepository } from '../core/jj-repository';
import type { JjRepositoryManager } from '../core/jj-repository-manager';
import type { LoggerChannel } from '../utils/output-channel';
import { createAbandonPayload } from './payloads/abandon.payload';
import { createAbsorbPayload } from './payloads/absorb.payload';
import { createSetBookmarkPayload } from './payloads/bookmark.payload';
import { createAdvanceBookmarkPayload } from './payloads/bookmark-advance.payload';
import { createAdvanceBookmarkAndUploadPayload } from './payloads/bookmark-advance-upload.payload';
import { createDeleteBookmarkPayload } from './payloads/bookmark-delete.payload';
import {
    createAckCommentPayload,
    createDoneCommentPayload,
    createReplyAndResolveCommentPayload,
    createReplyCommentPayload,
    createResolveCommentThreadPayload,
    createShowCommentsPayload,
    createUnresolveCommentThreadPayload,
} from './payloads/comments.payload';
import { createCommitPayload, createCommitPromptPayload } from './payloads/commit.payload';
import { createCompareAllFilesWithRevisionPayload } from './payloads/compare-all-files-with-revision.payload';
import { createCompareFileWithRevisionPayload } from './payloads/compare-file-with-revision.payload';
import { createCompleteSquashRevisionPayload } from './payloads/complete-squash-revision.payload';
import { createDescribePromptPayload, createSetDescriptionPayload } from './payloads/describe.payload';
import { createShowDetailsPayload } from './payloads/details.payload';
import { createDiscardChangePayload } from './payloads/discard-change.payload';
import { createDuplicatePayload } from './payloads/duplicate.payload';
import { createEditPayload } from './payloads/edit.payload';
import { createNewMergeChangePayload } from './payloads/merge.payload';
import { createOpenMergeEditorPayload } from './payloads/merge-editor.payload';
import { createShowMultiFileDiffPayload } from './payloads/multi-diff.payload';
import { createNewPayload } from './payloads/new.payload';
import { createNewAfterPayload } from './payloads/new-after.payload';
import { createNewBeforePayload } from './payloads/new-before.payload';
import { createOpenChangesPayload } from './payloads/open-changes.payload';
import { createOpenFilePayload } from './payloads/open-file.payload';
import { createRebaseOntoSelectedPayload } from './payloads/rebase.payload';
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
import { createUploadPayload } from './payloads/upload.payload';
import { createViewFileAtRevisionPayload } from './payloads/view-file-at-revision.payload';
import { createWorkspaceDeletePayload } from './payloads/workspace-delete.payload';
import { createWorkspaceForgetPayload } from './payloads/workspace-forget.payload';
import {
    createWorkspaceOpenInCurrentWindowPayload,
    createWorkspaceOpenInNewWindowPayload,
} from './payloads/workspace-open.payload';
import type { VsCodeLogWebviewProvider } from './providers/vscode-log-webview-provider';
import type { VsCodeScmProvider } from './providers/vscode-scm-provider';
import { VSCodeCommandContext } from './vscode-command-context';
import { VsCodeHostEnvironment } from './vscode-host-environment';

export interface RegisterCommandsOptions {
    context: vscode.ExtensionContext;
    repositoryManager: JjRepositoryManager;
    scmProviders: Map<string, VsCodeScmProvider>;
    outputChannel: LoggerChannel;
    commentsManager: CommentsManager;
    logWebviewProvider: VsCodeLogWebviewProvider;
    hostEnvironment?: VsCodeHostEnvironment;
}

export function registerCommands(options: RegisterCommandsOptions): void {
    const { context, repositoryManager, scmProviders, outputChannel, commentsManager, logWebviewProvider } = options;
    const host = options.hostEnvironment ?? new VsCodeHostEnvironment({ context });

    function resolveRepositoryLocal(
        args: unknown[],
        hostEnv: VsCodeHostEnvironment,
    ): { repo: JjRepository; scm?: VsCodeScmProvider } | undefined {
        const firstArg = args[0];
        if (firstArg && typeof firstArg === 'object' && 'id' in firstArg && 'resourceStates' in firstArg) {
            for (const scmProvider of scmProviders.values()) {
                if (scmProvider.ownsGroup(firstArg as vscode.SourceControlResourceGroup)) {
                    return { repo: scmProvider.repo, scm: scmProvider };
                }
            }
        }

        const repo = resolveRepository(repositoryManager, { args, host: hostEnv });
        if (!repo) {
            return undefined;
        }
        const scm = scmProviders.get(repo.rootUri.fsPath);
        return { repo, scm };
    }

    function registerCommandWithPayload<TPayload, TReturn = unknown>(
        commandId: string,
        payloadCreator: (args: unknown[], scm?: VsCodeScmProvider) => TPayload,
        handler: (ctx: CommandContext, payload: TPayload) => Promise<TReturn>,
    ): vscode.Disposable {
        return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
            const resolved = resolveRepositoryLocal(args, host);
            if (resolved?.repo) {
                repositoryManager.setFocusedRepository(resolved.repo);
                const cmdCtx = new VSCodeCommandContext(resolved.repo, host, outputChannel, commentsManager);
                const payload = payloadCreator(args, resolved.scm);
                return await handler(cmdCtx, payload);
            } else {
                const message = `[Command Error] Failed to resolve repository for command: ${commandId}`;
                outputChannel.error(message);
                await host.ui.showErrorMessage(message);
                return;
            }
        });
    }

    function registerCommand<TReturn = unknown>(
        commandId: string,
        handler: (ctx: CommandContext, ...args: unknown[]) => Promise<TReturn>,
    ): vscode.Disposable {
        return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
            const resolved = resolveRepositoryLocal(args, host);
            if (resolved?.repo) {
                repositoryManager.setFocusedRepository(resolved.repo);
                const cmdCtx = new VSCodeCommandContext(resolved.repo, host, outputChannel, commentsManager);
                return await handler(cmdCtx, ...args);
            } else {
                const message = `[Command Error] Failed to resolve repository for command: ${commandId}`;
                outputChannel.error(message);
                await host.ui.showErrorMessage(message);
                return;
            }
        });
    }

    context.subscriptions.push(
        registerCommand('jj-view.focusRepository', async () => {
            // No-op: registerCommand automatically resolves the clicked repository's rootUri and sets it as the focused repository.
        }),
        registerCommandWithPayload('jj-view.new', createNewPayload, newCommand),
        registerCommandWithPayload('jj-view.newMergeChange', createNewMergeChangePayload, newMergeChangeCommand),
        registerCommandWithPayload('jj-view.commit', createCommitPayload, commitCommand),
        registerCommandWithPayload('jj-view.commitPrompt', createCommitPromptPayload, commitPromptCommand),
        registerCommandWithPayload('jj-view.describePrompt', createDescribePromptPayload, describePromptCommand),
    );

    // focusDescriptionInput doesn't need repo context — it just focuses the SCM view
    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.focusDescriptionInput', async () => {
            await host.nav.focusScmInput?.();
        }),
    );

    context.subscriptions.push(
        registerCommandWithPayload('jj-view.showComments', createShowCommentsPayload, showCommentsCommand),
        registerCommandWithPayload('jj-view.ackComment', createAckCommentPayload, ackCommentCommand),
        registerCommandWithPayload('jj-view.doneComment', createDoneCommentPayload, doneCommentCommand),
        registerCommandWithPayload(
            'jj-view.replyAndResolveComment',
            createReplyAndResolveCommentPayload,
            replyAndResolveCommentCommand,
        ),
        registerCommandWithPayload('jj-view.replyComment', createReplyCommentPayload, replyCommentCommand),
        registerCommandWithPayload(
            'jj-view.resolveCommentThread',
            createResolveCommentThreadPayload,
            resolveCommentThreadCommand,
        ),
        registerCommandWithPayload(
            'jj-view.unresolveCommentThread',
            createUnresolveCommentThreadPayload,
            unresolveCommentThreadCommand,
        ),
        registerCommand('jj-view.copyUnresolvedComments', copyUnresolvedCommentsCommand),
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
        registerCommandWithPayload(
            'jj-view.completeSquashRevision',
            createCompleteSquashRevisionPayload,
            completeSquashRevisionCommand,
        ),
        registerCommandWithPayload('jj-view.setDescription', createSetDescriptionPayload, setDescriptionCommand),
        registerCommandWithPayload(
            'jj-view.squashSelectionIntoParent',
            () => createSquashSelectionIntoParentPayload(vscode.window.activeTextEditor),
            squashSelectionIntoParentCommand,
        ),
        registerCommand('jj-view.refresh', refreshCommand),
        registerCommandWithPayload('jj-view.openFile', createOpenFilePayload, openFileCommand),
        registerCommandWithPayload('jj-view.openChanges', createOpenChangesPayload, openChangesCommand),
        registerCommand('jj-view.undo', undoCommand),
        registerCommand('jj-view.redo', redoCommand),
        registerCommandWithPayload('jj-view.duplicate', createDuplicatePayload, duplicateCommand),
        registerCommandWithPayload('jj-view.edit', createEditPayload, editCommand),
        registerCommandWithPayload('jj-view.newBefore', createNewBeforePayload, newBeforeCommand),
        registerCommandWithPayload('jj-view.newAfter', createNewAfterPayload, newAfterCommand),
        registerCommandWithPayload('jj-view.upload', createUploadPayload, uploadCommand),
        registerCommandWithPayload('jj-view.setBookmark', createSetBookmarkPayload, setBookmarkCommand),
        registerCommandWithPayload('jj-view.advanceBookmark', createAdvanceBookmarkPayload, advanceBookmarkCommand),
        registerCommandWithPayload(
            'jj-view.advanceBookmarkAndUpload',
            createAdvanceBookmarkAndUploadPayload,
            advanceBookmarkAndUploadCommand,
        ),
        registerCommandWithPayload('jj-view.deleteBookmark', createDeleteBookmarkPayload, deleteBookmarkCommand),
        registerCommandWithPayload('jj-view.showDetails', createShowDetailsPayload, showDetailsCommand),
        registerCommandWithPayload('jj-view.openMergeEditor', createOpenMergeEditorPayload, openMergeEditorCommand),
        registerCommandWithPayload('jj-view.absorb', createAbsorbPayload, absorbCommand),
        registerCommandWithPayload(
            'jj-view.showMultiFileDiff',
            createShowMultiFileDiffPayload,
            showMultiFileDiffCommand,
        ),
        registerCommandWithPayload(
            'jj-view.compareWithWorkingCopy',
            createCompareAllFilesWithRevisionPayload,
            compareAllFilesWithRevisionCommand,
        ),
        registerCommandWithPayload(
            'jj-view.compareFileWith',
            createCompareFileWithRevisionPayload,
            compareFileWithRevisionCommand,
        ),
        registerCommandWithPayload(
            'jj-view.viewFileAtRevision',
            createViewFileAtRevisionPayload,
            viewFileAtRevisionCommand,
        ),
        registerCommand('jj-view.workspaceAdd', workspaceAddCommand),
        registerCommandWithPayload('jj-view.workspaceForget', createWorkspaceForgetPayload, workspaceForgetCommand),
        registerCommandWithPayload('jj-view.workspaceDelete', createWorkspaceDeletePayload, workspaceDeleteCommand),
        registerCommandWithPayload(
            'jj-view.workspaceOpenInCurrentWindow',
            createWorkspaceOpenInCurrentWindowPayload,
            workspaceOpenInCurrentWindowCommand,
        ),
        registerCommandWithPayload(
            'jj-view.workspaceOpenInNewWindow',
            createWorkspaceOpenInNewWindowPayload,
            workspaceOpenInNewWindowCommand,
        ),
        registerCommandWithPayload('jj-view.discardChange', createDiscardChangePayload, discardChangeCommand),
        registerCommandWithPayload(
            'jj-view.squashHunkIntoParent',
            createSquashHunkIntoParentPayload,
            squashHunkIntoParentCommand,
        ),
        registerCommandWithPayload(
            'jj-view.rebaseOntoSelected',
            createRebaseOntoSelectedPayload,
            rebaseOntoSelectedCommand,
        ),
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
                logWebviewProvider.controller.toggleAction(actionId),
            ),
            vscode.commands.registerCommand(`jj-view.toggleCommitAction.${actionId}.on`, () =>
                logWebviewProvider.controller.toggleAction(actionId),
            ),
            vscode.commands.registerCommand(`jj-view.toggleCommitAction.${actionId}.off`, () =>
                logWebviewProvider.controller.toggleAction(actionId),
            ),
        );
    }

    const refreshDisposable = vscode.commands.registerCommand('jj-view.refreshGraph', async () => {
        await logWebviewProvider.controller.refresh();
    });
    context.subscriptions.push(refreshDisposable);

    const refreshCmd = vscode.commands.registerCommand('jj-view.refreshLog', () =>
        logWebviewProvider.controller.refresh(),
    );
    context.subscriptions.push(refreshCmd);
}

export { registerCommands as registerVSCodeCommands };
