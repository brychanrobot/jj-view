/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeForgeAuthManager } from '../../../src/core/code-forge-auth';
import { abandonCommand } from '../../../src/core/commands/abandon';
import { absorbCommand } from '../../../src/core/commands/absorb';
import { setBookmarkCommand } from '../../../src/core/commands/bookmark';
import { advanceBookmarkCommand } from '../../../src/core/commands/bookmark-advance';
import { advanceBookmarkAndUploadCommand } from '../../../src/core/commands/bookmark-advance-upload';
import { deleteBookmarkCommand } from '../../../src/core/commands/bookmark-delete';
import {
    ackCommentCommand,
    copyUnresolvedCommentsCommand,
    doneCommentCommand,
    replyAndResolveCommentCommand,
    replyCommentCommand,
    resolveCommentThreadCommand,
    showCommentsCommand,
    unresolveCommentThreadCommand,
} from '../../../src/core/commands/comments';
import { commitCommand } from '../../../src/core/commands/commit';
import { commitPromptCommand } from '../../../src/core/commands/commit-prompt';
import { compareAllFilesWithRevisionCommand } from '../../../src/core/commands/compare-all-files-with-revision';
import { compareFileWithRevisionCommand } from '../../../src/core/commands/compare-file-with-revision';
import { setDescriptionCommand } from '../../../src/core/commands/describe';
import { describePromptCommand } from '../../../src/core/commands/describe-prompt';
import { showDetailsCommand } from '../../../src/core/commands/details';
import { discardChangeCommand } from '../../../src/core/commands/discard-change';
import { duplicateCommand } from '../../../src/core/commands/duplicate';
import { editCommand } from '../../../src/core/commands/edit';
import { newMergeChangeCommand } from '../../../src/core/commands/merge';
import { openMergeEditorCommand } from '../../../src/core/commands/merge-editor';
import { showMultiFileDiffCommand } from '../../../src/core/commands/multi-diff';
import { newCommand } from '../../../src/core/commands/new';
import { newAfterCommand } from '../../../src/core/commands/new-after';
import { newBeforeCommand } from '../../../src/core/commands/new-before';
import { openChangesCommand, openFileCommand } from '../../../src/core/commands/open';
import { rebaseOntoSelectedCommand } from '../../../src/core/commands/rebase';
import { redoCommand } from '../../../src/core/commands/redo';
import { refreshCommand } from '../../../src/core/commands/refresh';
import { restoreCommand } from '../../../src/core/commands/restore';
import {
    squashFilesIntoAncestorCommand,
    squashFilesIntoChildCommand,
    squashFilesIntoParentCommand,
} from '../../../src/core/commands/squash-files';
import {
    completeSquashRevisionCommand,
    squashRevisionIntoAncestorCommand,
    squashRevisionIntoParentCommand,
} from '../../../src/core/commands/squash-revision';
import {
    squashHunkIntoParentCommand,
    squashSelectionIntoParentCommand,
} from '../../../src/core/commands/squash-selection';
import { undoCommand } from '../../../src/core/commands/undo';
import { uploadCommand } from '../../../src/core/commands/upload';
import { uploadStackCommand } from '../../../src/core/commands/upload-stack';
import { viewFileAtRevisionCommand } from '../../../src/core/commands/view-file-at-revision';
import { workspaceAddCommand } from '../../../src/core/commands/workspace-add';
import { workspaceDeleteCommand } from '../../../src/core/commands/workspace-delete';
import { workspaceForgetCommand } from '../../../src/core/commands/workspace-forget';
import {
    workspaceOpenInCurrentWindowCommand,
    workspaceOpenInNewWindowCommand,
} from '../../../src/core/commands/workspace-open';
import type { LogViewController } from '../../../src/core/controllers/log-view-controller';
import { BaseCommandContext, type CommandContext } from '../../../src/core/host/command-context';
import type { HostEnvironment } from '../../../src/core/host/host-environment';
import { TOGGLEABLE_COMMIT_ACTIONS } from '../../../src/core/host/ipc/log-view-schemas';
import type { JjRepository } from '../../../src/core/jj-repository';
import type { JjRepositoryManager } from '../../../src/core/jj-repository-manager';
import type { ScmModel } from '../../../src/core/scm-model';
import type { LoggerChannel } from '../../../src/utils/output-channel';
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
import { createOpenChangesPayload, createOpenFilePayload } from './payloads/open.payload';
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
import { createUploadPayload, createUploadStackPayload } from './payloads/upload.payload';
import { createViewFileAtRevisionPayload } from './payloads/view-file-at-revision.payload';
import {
    createWorkspaceDeletePayload,
    createWorkspaceForgetPayload,
    createWorkspaceOpenInCurrentWindowPayload,
    createWorkspaceOpenInNewWindowPayload,
} from './payloads/workspace.payload';

export interface RegisterWebCommandsOptions {
    repositoryManager: JjRepositoryManager;
    hostEnvironment: HostEnvironment;
    logger: LoggerChannel;
    scmModel: ScmModel;
    logViewController?: LogViewController;
    authManager?: CodeForgeAuthManager;
}

export function registerWebCommands(options: RegisterWebCommandsOptions): void {
    const { repositoryManager, hostEnvironment, logger, scmModel, logViewController, authManager } = options;

    function getActiveRepo(): JjRepository | undefined {
        return repositoryManager.focusedRepository ?? repositoryManager.repositories[0] ?? scmModel.repo;
    }

    function createCmdContext(repo: JjRepository): CommandContext {
        return new BaseCommandContext(repo, hostEnvironment, logger);
    }

    function registerWithPayload<TPayload, TReturn = unknown>(
        commandId: string,
        payloadCreator: (args: unknown[], hostEnvironment?: HostEnvironment) => TPayload,
        handler: (ctx: CommandContext, payload: TPayload) => Promise<TReturn>,
    ): void {
        hostEnvironment.commands.registerCommand(commandId, async (...args: unknown[]) => {
            const repo = getActiveRepo();
            if (!repo) {
                logger.error(`[Command Error] No active repository for command: ${commandId}`);
                await hostEnvironment.ui.showErrorMessage(`No active repository for command: ${commandId}`);
                return;
            }
            const ctx = createCmdContext(repo);
            const payload = payloadCreator(args, hostEnvironment);
            const result = await handler(ctx, payload);
            await repo.refresh();
            return result;
        });
    }

    function registerDirect<TReturn = unknown>(
        commandId: string,
        handler: (ctx: CommandContext, ...args: unknown[]) => Promise<TReturn>,
    ): void {
        hostEnvironment.commands.registerCommand(commandId, async (...args: unknown[]) => {
            const repo = getActiveRepo();
            if (!repo) {
                logger.error(`[Command Error] No active repository for command: ${commandId}`);
                await hostEnvironment.ui.showErrorMessage(`No active repository for command: ${commandId}`);
                return;
            }
            const ctx = createCmdContext(repo);
            const result = await handler(ctx, ...args);
            await repo.refresh();
            return result;
        });
    }

    // 1. Navigation & Focus Commands
    hostEnvironment.commands.registerCommand('jj-view.focusRepository', async () => {
        const repo = getActiveRepo();
        if (repo) {
            repositoryManager.setFocusedRepository(repo);
        }
    });

    hostEnvironment.commands.registerCommand('jj-view.focusDescriptionInput', async () => {
        await hostEnvironment.nav.focusScmInput?.();
    });

    // 2. Commit, Describe, New
    registerWithPayload('jj-view.new', createNewPayload, newCommand);
    registerWithPayload('jj-view.newMergeChange', createNewMergeChangePayload, newMergeChangeCommand);
    registerWithPayload('jj-view.newBefore', createNewBeforePayload, newBeforeCommand);
    registerWithPayload('jj-view.newAfter', createNewAfterPayload, newAfterCommand);

    registerWithPayload('jj-view.commit', (args) => createCommitPayload(args, scmModel), commitCommand);

    registerWithPayload(
        'jj-view.commitPrompt',
        (args) => createCommitPromptPayload(args, scmModel),
        commitPromptCommand,
    );

    registerWithPayload(
        'jj-view.setDescription',
        (args) => createSetDescriptionPayload(args, scmModel),
        setDescriptionCommand,
    );

    registerWithPayload(
        'jj-view.describePrompt',
        (args) => createDescribePromptPayload(args, scmModel),
        describePromptCommand,
    );
    registerWithPayload(
        'jj-view.describe',
        (args) => createSetDescriptionPayload(args, scmModel),
        setDescriptionCommand,
    );

    // 3. Status, Refresh, Undo, Redo
    registerDirect('jj-view.refresh', refreshCommand);
    registerDirect('jj-view.undo', undoCommand);
    registerDirect('jj-view.redo', redoCommand);

    // 4. Working Copy File Operations
    registerWithPayload('jj-view.restore', createRestorePayload, restoreCommand);
    registerWithPayload('jj-view.discardChange', createDiscardChangePayload, discardChangeCommand);
    registerWithPayload('jj-view.openFile', createOpenFilePayload, openFileCommand);
    registerWithPayload('jj-view.openChanges', createOpenChangesPayload, openChangesCommand);
    registerWithPayload('vscode.diff', createOpenChangesPayload, openChangesCommand);
    registerWithPayload('jj-view.openMergeEditor', createOpenMergeEditorPayload, openMergeEditorCommand);

    // 5. Revision Manipulation
    registerWithPayload(
        'jj-view.abandon',
        (args) => createAbandonPayload(args, scmModel.getSelectedCommitIds()),
        abandonCommand,
    );
    registerWithPayload('jj-view.edit', createEditPayload, editCommand);
    registerWithPayload('jj-view.duplicate', createDuplicatePayload, duplicateCommand);
    registerWithPayload(
        'jj-view.rebaseOntoSelected',
        (args) => createRebaseOntoSelectedPayload(args, scmModel.getSelectedCommitIds()),
        rebaseOntoSelectedCommand,
    );
    registerWithPayload('jj-view.absorb', createAbsorbPayload, absorbCommand);

    // 6. Squashing
    registerWithPayload(
        'jj-view.squashRevisionIntoParent',
        createSquashRevisionIntoParentPayload,
        squashRevisionIntoParentCommand,
    );
    registerWithPayload(
        'jj-view.squashRevisionIntoAncestor',
        createSquashRevisionIntoAncestorPayload,
        squashRevisionIntoAncestorCommand,
    );
    registerWithPayload(
        'jj-view.completeSquashRevision',
        createCompleteSquashRevisionPayload,
        completeSquashRevisionCommand,
    );
    registerWithPayload(
        'jj-view.squashFilesIntoParent',
        createSquashFilesIntoParentPayload,
        squashFilesIntoParentCommand,
    );
    registerWithPayload(
        'jj-view.squashFilesIntoAncestor',
        createSquashFilesIntoAncestorPayload,
        squashFilesIntoAncestorCommand,
    );
    registerWithPayload('jj-view.squashFilesIntoChild', createSquashFilesIntoChildPayload, squashFilesIntoChildCommand);
    registerWithPayload(
        'jj-view.squashSelectionIntoParent',
        createSquashSelectionIntoParentPayload,
        squashSelectionIntoParentCommand,
    );
    registerWithPayload('jj-view.squashHunkIntoParent', createSquashHunkIntoParentPayload, squashHunkIntoParentCommand);

    // 7. Bookmarks & Remote Upload
    registerWithPayload('jj-view.setBookmark', createSetBookmarkPayload, setBookmarkCommand);
    registerWithPayload('jj-view.advanceBookmark', createAdvanceBookmarkPayload, advanceBookmarkCommand);
    registerWithPayload(
        'jj-view.advanceBookmarkAndUpload',
        createAdvanceBookmarkAndUploadPayload,
        advanceBookmarkAndUploadCommand,
    );
    registerWithPayload('jj-view.deleteBookmark', createDeleteBookmarkPayload, deleteBookmarkCommand);
    registerWithPayload('jj-view.upload', createUploadPayload, uploadCommand);
    registerWithPayload('jj-view.uploadStack', createUploadStackPayload, uploadStackCommand);

    // 8. Details & Multi-Diff
    registerWithPayload('jj-view.showDetails', createShowDetailsPayload, showDetailsCommand);
    registerWithPayload('jj-view.showMultiFileDiff', createShowMultiFileDiffPayload, showMultiFileDiffCommand);
    registerWithPayload(
        'jj-view.compareWithWorkingCopy',
        createCompareAllFilesWithRevisionPayload,
        compareAllFilesWithRevisionCommand,
    );
    registerWithPayload(
        'jj-view.compareFileWith',
        createCompareFileWithRevisionPayload,
        compareFileWithRevisionCommand,
    );
    registerWithPayload('jj-view.viewFileAtRevision', createViewFileAtRevisionPayload, viewFileAtRevisionCommand);

    // 9. Workspaces
    registerDirect('jj-view.workspaceAdd', workspaceAddCommand);
    registerWithPayload('jj-view.workspaceForget', createWorkspaceForgetPayload, workspaceForgetCommand);
    registerWithPayload('jj-view.workspaceDelete', createWorkspaceDeletePayload, workspaceDeleteCommand);
    registerWithPayload(
        'jj-view.workspaceOpenInCurrentWindow',
        createWorkspaceOpenInCurrentWindowPayload,
        workspaceOpenInCurrentWindowCommand,
    );
    registerWithPayload(
        'jj-view.workspaceOpenInNewWindow',
        createWorkspaceOpenInNewWindowPayload,
        workspaceOpenInNewWindowCommand,
    );

    // 10. Comments
    registerWithPayload('jj-view.showComments', createShowCommentsPayload, showCommentsCommand);
    registerWithPayload('jj-view.ackComment', createAckCommentPayload, ackCommentCommand);
    registerWithPayload('jj-view.doneComment', createDoneCommentPayload, doneCommentCommand);
    registerWithPayload(
        'jj-view.replyAndResolveComment',
        createReplyAndResolveCommentPayload,
        replyAndResolveCommentCommand,
    );
    registerWithPayload('jj-view.replyComment', createReplyCommentPayload, replyCommentCommand);
    registerWithPayload('jj-view.resolveCommentThread', createResolveCommentThreadPayload, resolveCommentThreadCommand);
    registerWithPayload(
        'jj-view.unresolveCommentThread',
        createUnresolveCommentThreadPayload,
        unresolveCommentThreadCommand,
    );
    registerDirect('jj-view.copyUnresolvedComments', copyUnresolvedCommentsCommand);

    // 11. Settings, Process Monitor & Auth
    hostEnvironment.commands.registerCommand('jj-view.openSettings', async (settingId?: string) => {
        await hostEnvironment.nav.openSettings(settingId);
    });
    hostEnvironment.commands.registerCommand('workbench.action.openSettings', async (settingId?: string) => {
        await hostEnvironment.nav.openSettings(settingId);
    });
    hostEnvironment.commands.registerCommand('jj-view.showProcessMonitor', async () => {});
    hostEnvironment.commands.registerCommand('jj-view.killProcess', async () => {});
    hostEnvironment.commands.registerCommand('jj-view.killAllProcesses', async () => {});
    hostEnvironment.commands.registerCommand('jj-view.clearProcessHistory', async () => {});
    hostEnvironment.commands.registerCommand('jj-view.manageAuth', async () => {
        const repo = getActiveRepo();
        const activeProvider = repo?.codeForge.activeProvider;
        if (!activeProvider) {
            await hostEnvironment.ui.showErrorMessage('No active code forge provider detected.');
            return;
        }
        if (!activeProvider.isAuthManageable) {
            await hostEnvironment.ui.showInformation(
                `Authentication management is not supported for ${activeProvider.displayName}.`,
            );
            return;
        }

        const providerId = activeProvider.id;
        const isSkipped = authManager ? await authManager.isAuthSkipped(providerId) : false;
        const items: { label: string; description?: string; detail?: string; execute: () => Promise<void> }[] = [];

        if (authManager && !(await activeProvider.hasAuth?.())) {
            items.push({
                label: isSkipped
                    ? '$(pass) Enable Authentication Prompts'
                    : '$(circle-slash) Disable Authentication Prompts',
                description: `Currently ${isSkipped ? 'disabled (skipped)' : 'enabled'} for ${activeProvider.displayName}`,
                execute: async () => {
                    await authManager.setAuthSkipped(providerId, !isSkipped);
                    void hostEnvironment.ui.showInformation(
                        `Authentication prompts for ${activeProvider.displayName} have been ${!isSkipped ? 'disabled' : 'enabled'}.`,
                    );
                    repo?.codeForge.forceRefresh();
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

        if (authManager) {
            items.push({
                label: '$(refresh) Reset All Preferences',
                description: 'Reset auth preferences for all code forge providers',
                execute: async () => {
                    await authManager.resetAllChoices();
                    void hostEnvironment.ui.showInformation('Authentication preferences have been reset.');
                    repo?.codeForge.forceRefresh();
                },
            });
        }

        const choice = await hostEnvironment.ui.showQuickPick(items, {
            placeHolder: `Manage Authentication for ${activeProvider.displayName}`,
        });

        if (!choice) {
            return;
        }

        await choice.execute();
    });

    // 12. Log & Graph Actions
    if (logViewController) {
        for (const actionId of TOGGLEABLE_COMMIT_ACTIONS) {
            hostEnvironment.commands.registerCommand(`jj-view.hideCommitAction.${actionId}`, () =>
                logViewController.toggleAction(actionId),
            );
            hostEnvironment.commands.registerCommand(`jj-view.toggleCommitAction.${actionId}.on`, () =>
                logViewController.toggleAction(actionId),
            );
            hostEnvironment.commands.registerCommand(`jj-view.toggleCommitAction.${actionId}.off`, () =>
                logViewController.toggleAction(actionId),
            );
        }
    }

    hostEnvironment.commands.registerCommand('jj-view.refreshGraph', async () => {
        await logViewController?.refresh();
        const repo = getActiveRepo();
        await repo?.refresh();
    });
    hostEnvironment.commands.registerCommand('jj-view.refreshLog', async () => {
        await logViewController?.refresh();
    });
}
