/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PackageJsonContributes } from './menu-types';

export const DEFAULT_PACKAGE_JSON_CONTRIBUTES: PackageJsonContributes = {
    commands: [
        {
            command: 'jj-view.focusRepository',
            title: 'Show Repository in JJ Log',
            category: 'JJ View',
            icon: '$(eye)',
        },
        {
            command: 'jj-view.newMergeChange',
            title: 'New Merge Change',
            category: 'JJ View',
            icon: '$(git-merge)',
        },
        {
            command: 'jj-view.new',
            title: 'New',
            category: 'JJ View',
            icon: '$(plus)',
        },
        {
            command: 'jj-view.setDescription',
            title: 'Set Description',
            category: 'JJ View',
            icon: '$(save)',
        },
        {
            command: 'jj-view.describePrompt',
            title: 'Set Description (Prompt)',
            category: 'JJ View',
            icon: '$(save)',
        },
        {
            command: 'jj-view.focusDescriptionInput',
            title: 'Focus SCM Description Input',
            category: 'JJ View',
        },
        {
            command: 'jj-view.commit',
            title: 'Commit',
            category: 'JJ View',
            icon: '$(check)',
        },
        {
            command: 'jj-view.commitPrompt',
            title: 'Commit (Prompt)',
            category: 'JJ View',
            icon: '$(check)',
        },
        {
            command: 'jj-view.compareWithWorkingCopy',
            title: 'Compare All Files with Revision...',
            category: 'JJ View',
        },
        {
            command: 'jj-view.compareFileWith',
            title: 'Compare File with Revision...',
            category: 'JJ View',
        },
        {
            command: 'jj-view.viewFileAtRevision',
            title: 'View File at Revision...',
            category: 'JJ View',
        },
        {
            command: 'jj-view.refresh',
            title: 'Refresh',
            category: 'JJ View',
            icon: '$(refresh)',
        },
        {
            command: 'jj-view.restore',
            title: 'Restore',
            category: 'JJ View',
            icon: '$(discard)',
        },
        {
            command: 'jj-view.squashRevisionIntoParent',
            title: 'Squash Revision into Parent',
            category: 'JJ View',
            icon: '$(arrow-down)',
        },
        {
            command: 'jj-view.squashRevisionIntoAncestor',
            title: 'Squash Revision into Ancestor...',
            category: 'JJ View',
            icon: '$(jj-icon-squash-into)',
        },
        {
            command: 'jj-view.openFile',
            title: 'Open File in Working Copy',
            category: 'JJ View',
            icon: '$(go-to-file)',
        },
        {
            command: 'jj-view.openChanges',
            title: 'Open Changes',
            category: 'JJ View',
            icon: '$(diff)',
        },
        {
            command: 'jj-view.undo',
            title: 'Undo',
            category: 'JJ View',
            icon: '$(discard)',
        },
        {
            command: 'jj-view.redo',
            title: 'Redo',
            category: 'JJ View',
            icon: '$(redo)',
        },
        {
            command: 'jj-view.duplicate',
            title: 'Duplicate',
            category: 'JJ View',
        },
        {
            command: 'jj-view.abandon',
            title: 'Abandon',
            category: 'JJ View',
            icon: '$(trash)',
        },
        {
            command: 'jj-view.edit',
            title: 'Edit',
            category: 'JJ View',
            icon: '$(edit)',
        },
        {
            command: 'jj-view.newBefore',
            title: 'New Before',
            category: 'JJ View',
            icon: '$(source-control)',
        },
        {
            command: 'jj-view.newAfter',
            title: 'New After',
            category: 'JJ View',
            icon: '$(source-control)',
        },
        {
            command: 'jj-view.squashSelectionIntoParent',
            title: 'Squash Selection into Parent',
            category: 'JJ View',
        },
        {
            command: 'jj-view.openMergeEditor',
            title: 'Open Merge Editor',
            category: 'JJ View',
            icon: '$(git-merge)',
        },
        {
            command: 'jj-view.completeSquashRevision',
            title: 'Complete Squash Revision',
            category: 'JJ View',
            icon: '$(check)',
        },
        {
            command: 'jj-view.rebaseOntoSelected',
            title: 'Rebase onto Selected',
            category: 'JJ View',
            icon: '$(git-merge)',
        },
        {
            command: 'jj-view.showDetails',
            title: 'Show Details',
            category: 'JJ View',
            icon: '$(list-selection)',
        },
        {
            command: 'jj-view.discardChange',
            title: 'Discard Change',
            category: 'JJ View',
            icon: '$(discard)',
        },
        {
            command: 'jj-view.squashHunkIntoParent',
            title: 'Squash Hunk into Parent',
            category: 'JJ View',
            icon: '$(repo-pull)',
        },
        {
            command: 'jj-view.squashFilesIntoChild',
            title: 'Squash File(s) into Child',
            category: 'JJ View',
            icon: '$(arrow-up)',
        },
        {
            command: 'jj-view.squashFilesIntoParent',
            title: 'Squash File(s) into Parent',
            category: 'JJ View',
            icon: '$(arrow-down)',
        },
        {
            command: 'jj-view.squashFilesIntoAncestor',
            title: 'Squash File(s) into Ancestor...',
            category: 'JJ View',
            icon: '$(jj-icon-squash-into)',
        },
        {
            command: 'jj-view.setBookmark',
            title: 'Set Bookmark',
            category: 'JJ View',
            icon: '$(bookmark)',
        },
        {
            command: 'jj-view.advanceBookmark',
            title: 'Advance Bookmark',
            category: 'JJ View',
            icon: '$(bookmark)',
        },
        {
            command: 'jj-view.advanceBookmarkAndUpload',
            title: 'Advance Bookmark & Upload',
            category: 'JJ View',
            icon: '$(cloud-upload)',
        },
        {
            command: 'jj-view.upload',
            title: 'Upload',
            category: 'JJ View',
            icon: '$(cloud-upload)',
        },
        {
            command: 'jj-view.uploadStack',
            title: 'Upload Stack',
            category: 'JJ View',
            icon: '$(cloud-upload)',
        },
        {
            command: 'jj-view.deleteBookmark',
            title: 'Delete Bookmark',
            category: 'JJ View',
            icon: '$(trash)',
        },
        {
            command: 'jj-view.absorb',
            title: 'Absorb',
            category: 'JJ View',
            icon: '$(magnet)',
        },
        {
            command: 'jj-view.showMultiFileDiff',
            title: 'Show Multi-File Diff',
            category: 'JJ View',
            icon: '$(diff-multiple)',
        },
        {
            command: 'jj-view.workspaceAdd',
            title: 'Add Workspace',
            category: 'JJ View',
            icon: '$(jj-icon-workspace-add)',
        },
        {
            command: 'jj-view.workspaceForget',
            title: 'Forget Workspace',
            category: 'JJ View',
            icon: '$(close)',
        },
        {
            command: 'jj-view.workspaceDelete',
            title: 'Delete Workspace Directory',
            category: 'JJ View',
            icon: '$(trash)',
        },
        {
            command: 'jj-view.workspaceOpenInCurrentWindow',
            title: 'Open in Current Window',
            category: 'JJ View',
            icon: '$(window)',
        },
        {
            command: 'jj-view.workspaceOpenInNewWindow',
            title: 'Open in New Window',
            category: 'JJ View',
            icon: '$(empty-window)',
        },
        {
            command: 'jj-view.hideCommitAction.newChild',
            title: "Hide 'New Child'",
            category: 'JJ View',
        },
        {
            command: 'jj-view.hideCommitAction.edit',
            title: "Hide 'Edit'",
            category: 'JJ View',
        },
        {
            command: 'jj-view.hideCommitAction.squash',
            title: "Hide 'Squash'",
            category: 'JJ View',
        },
        {
            command: 'jj-view.showProcessMonitor',
            title: 'Show Process Monitor',
            category: 'JJ View',
        },
        {
            command: 'jj-view.killProcess',
            title: 'Kill Specific JJ Process',
            category: 'JJ View',
        },
        {
            command: 'jj-view.killAllProcesses',
            title: 'Kill All Running JJ Processes',
            category: 'JJ View',
        },
        {
            command: 'jj-view.clearProcessHistory',
            title: 'Clear Process Monitor History',
            category: 'JJ View',
        },
        {
            command: 'jj-view.hideCommitAction.abandon',
            title: "Hide 'Abandon'",
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.newChild.on',
            title: '● New Child',
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.newChild.off',
            title: '○ New Child',
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.edit.on',
            title: '● Edit',
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.edit.off',
            title: '○ Edit',
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.squash.on',
            title: '● Squash',
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.squash.off',
            title: '○ Squash',
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.abandon.on',
            title: '● Abandon',
            category: 'JJ View',
        },
        {
            command: 'jj-view.toggleCommitAction.abandon.off',
            title: '○ Abandon',
            category: 'JJ View',
        },
        {
            command: 'jj-view.manageAuth',
            title: 'Manage Code Forge Authentication',
            category: 'JJ View',
            icon: '$(key)',
        },
        {
            command: 'jj-view.showComments',
            title: 'Show Comments',
            category: 'JJ View',
        },
        {
            command: 'jj-view.ackComment',
            title: 'Ack',
            category: 'JJ View',
        },
        {
            command: 'jj-view.doneComment',
            title: 'Done',
            category: 'JJ View',
        },
        {
            command: 'jj-view.replyAndResolveComment',
            title: 'Reply & Resolve',
            category: 'JJ View',
        },
        {
            command: 'jj-view.replyComment',
            title: 'Reply',
            category: 'JJ View',
        },
        {
            command: 'jj-view.resolveCommentThread',
            title: 'Resolve Thread',
            category: 'JJ View',
            icon: '$(check)',
        },
        {
            command: 'jj-view.unresolveCommentThread',
            title: 'Unresolve Thread',
            category: 'JJ View',
            icon: '$(reply)',
        },
        {
            command: 'jj-view.copyUnresolvedComments',
            title: 'Copy Unresolved Comments',
            category: 'JJ View',
            icon: '$(copy)',
        },
        {
            command: 'workbench.action.closeActiveEditor',
            title: 'Close',
        },
        {
            command: 'workbench.action.closeOtherEditors',
            title: 'Close Others',
        },
        {
            command: 'workbench.action.closeEditorsToTheRight',
            title: 'Close to the Right',
        },
        {
            command: 'workbench.action.closeAllEditors',
            title: 'Close All',
        },
    ],
    menus: {
        commandPalette: [
            {
                command: 'jj-view.uploadStack',
                when: "!config.jj-view.alwaysUploadStack && jj.codeForgeProvider != 'gerrit'",
            },
            {
                command: 'jj-view.killProcess',
                when: 'false',
            },
            {
                command: 'jj-view.killAllProcesses',
                when: 'false',
            },
            {
                command: 'jj-view.clearProcessHistory',
                when: 'false',
            },
            {
                command: 'jj-view.showComments',
                when: 'false',
            },
            {
                command: 'jj-view.ackComment',
                when: 'false',
            },
            {
                command: 'jj-view.doneComment',
                when: 'false',
            },
            {
                command: 'jj-view.replyAndResolveComment',
                when: 'false',
            },
            {
                command: 'jj-view.replyComment',
                when: 'false',
            },
            {
                command: 'jj-view.resolveCommentThread',
                when: 'false',
            },
            {
                command: 'jj-view.unresolveCommentThread',
                when: 'false',
            },
            {
                command: 'jj-view.copyUnresolvedComments',
                when: 'false',
            },
            {
                command: 'jj-view.squashHunkIntoParent',
                when: 'false',
            },
            {
                command: 'jj-view.squashSelectionIntoParent',
                when: 'false',
            },
            {
                command: 'jj-view.squashFilesIntoParent',
                when: 'false',
            },
            {
                command: 'jj-view.squashFilesIntoAncestor',
                when: 'false',
            },
            {
                command: 'jj-view.squashFilesIntoChild',
                when: 'false',
            },
            {
                command: 'jj-view.completeSquashRevision',
                when: 'false',
            },
            {
                command: 'jj-view.openMergeEditor',
                when: 'false',
            },
            {
                command: 'jj-view.hideCommitAction.newChild',
                when: 'false',
            },
            {
                command: 'jj-view.hideCommitAction.edit',
                when: 'false',
            },
            {
                command: 'jj-view.hideCommitAction.squash',
                when: 'false',
            },
            {
                command: 'jj-view.hideCommitAction.abandon',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.newChild.on',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.newChild.off',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.edit.on',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.edit.off',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.squash.on',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.squash.off',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.abandon.on',
                when: 'false',
            },
            {
                command: 'jj-view.toggleCommitAction.abandon.off',
                when: 'false',
            },
        ],
        'view/title': [
            {
                command: 'jj-view.undo',
                group: 'navigation@1',
                when: 'view == jj-view.logView',
            },
            {
                command: 'jj-view.redo',
                group: 'navigation@2',
                when: 'view == jj-view.logView',
            },
            {
                command: 'jj-view.abandon',
                group: 'navigation@3',
                when: 'view == jj-view.logView && jj.selection.allowAbandon',
            },
            {
                command: 'jj-view.newMergeChange',
                group: 'navigation@4',
                when: 'view == jj-view.logView && jj.selection.allowMerge',
            },
            {
                command: 'jj-view.newBefore',
                group: 'navigation@5',
                when: 'view == jj-view.logView && jj.selection.allowNewBefore',
            },
            {
                command: 'jj-view.workspaceAdd',
                group: 'navigation@10',
                when: 'view == jj-view.logView',
            },
            {
                command: 'jj-view.copyUnresolvedComments',
                group: 'navigation',
                when: 'view == workbench.panel.comments && jj.codeForgeActive',
            },
        ],
        'scm/title': [
            {
                command: 'jj-view.focusRepository',
                group: 'navigation@0',
                when: 'scmProvider =~ /^jj/ && scm.providerCount > 1',
            },
            {
                command: 'jj-view.new',
                group: 'navigation@1',
            },
            {
                command: 'jj-view.setDescription',
                group: 'navigation@2',
            },
            {
                command: 'jj-view.commit',
                group: 'navigation@3',
            },
            {
                command: 'jj-view.refresh',
                group: 'navigation@10',
            },
            {
                command: 'jj-view.manageAuth',
                group: 'navigation@0',
                when: 'jj.codeForgeAuthManageable',
            },
        ],
        'scm/resourceGroup/context': [
            {
                command: 'jj-view.absorb',
                group: 'inline',
                when: 'scmResourceGroupState =~ /\\bjj\\.group\\.allowAbsorb\\b/',
            },
            {
                command: 'jj-view.showMultiFileDiff',
                group: 'inline@1',
                when: 'scmResourceGroupState =~ /\\bjj\\.group\\.allowShowMultiFileDiff\\b/',
            },
            {
                command: 'jj-view.abandon',
                group: 'inline@2',
                when: 'scmResourceGroupState =~ /\\bjj\\.group\\.allowAbandon\\b/',
            },
            {
                command: 'jj-view.squashRevisionIntoAncestor',
                group: 'inline@3',
                when: 'scmResourceGroupState =~ /\\bjj\\.group\\.allowSquash\\b/',
            },
            {
                command: 'jj-view.squashRevisionIntoParent',
                group: 'inline@4',
                when: 'scmResourceGroupState =~ /\\bjj\\.group\\.allowSquash\\b/',
            },
            {
                command: 'jj-view.showDetails',
                group: 'inline@5',
                when: 'scmResourceGroupState =~ /\\bjj\\.group\\.allowShowDetails\\b/',
            },
            {
                command: 'jj-view.edit',
                group: 'inline@6',
                when: 'scmResourceGroupState =~ /\\bjj\\.group\\.allowEdit\\b/',
            },
        ],
        'scm/resourceState/context': [
            {
                command: 'jj-view.openFile',
                group: 'inline@1',
                when: 'scmResourceState =~ /\\bjj\\.resource\\.allowOpen\\b/ && jj.openDiffOnClick || scmResourceState =~ /\\bjj\\.resource\\.allowOpenMergeEditor\\b/',
            },
            {
                command: 'jj-view.openChanges',
                group: 'inline@1',
                when: 'scmResourceState =~ /\\bjj\\.resource\\.allowOpen\\b/ && !jj.openDiffOnClick || scmResourceState =~ /\\bjj\\.resource\\.allowOpenMergeEditor\\b/',
            },
            {
                command: 'jj-view.restore',
                group: 'inline@2',
                when: 'scmResourceState =~ /\\bjj\\.resource\\.allowRestore\\b/',
            },
            {
                command: 'jj-view.squashFilesIntoAncestor',
                group: 'inline@3',
                when: 'scmResourceState =~ /\\bjj\\.resource\\.allowSquashIntoAncestor\\b/',
            },
            {
                command: 'jj-view.squashFilesIntoParent',
                group: 'inline@4',
                when: 'scmResourceState =~ /\\bjj\\.resource\\.allowSquashIntoParent\\b/',
            },
            {
                command: 'jj-view.squashFilesIntoChild',
                group: 'inline@5',
                when: 'scmResourceState =~ /\\bjj\\.resource\\.allowSquashIntoChild\\b/',
            },
        ],
        'webview/context': [
            {
                command: 'jj-view.workspaceForget',
                when: "webviewSection == 'workspace'",
                group: '1_workspace@1',
            },
            {
                command: 'jj-view.workspaceDelete',
                when: "webviewSection == 'workspace'",
                group: '1_workspace@2',
            },
            {
                command: 'jj-view.workspaceOpenInCurrentWindow',
                when: "webviewSection == 'workspace'",
                group: '2_workspace@1',
            },
            {
                command: 'jj-view.workspaceOpenInNewWindow',
                when: "webviewSection == 'workspace'",
                group: '2_workspace@2',
            },
            {
                command: 'jj-view.showMultiFileDiff',
                when: "webviewSection == 'commit'",
                group: '1_diff@1',
            },
            {
                command: 'jj-view.compareWithWorkingCopy',
                when: "webviewSection == 'commit' && !jj.isCurrentWorkingCopy",
                group: '1_diff@2',
            },
            {
                command: 'jj-view.new',
                when: "webviewSection == 'commit' && jj.canNewChild",
                group: '2_edit@1',
            },
            {
                command: 'jj-view.newBefore',
                when: "webviewSection == 'commit' && jj.canNewBefore",
                group: '2_edit@2',
            },
            {
                command: 'jj-view.newAfter',
                when: "webviewSection == 'commit' && jj.canNewAfter",
                group: '2_edit@3',
            },
            {
                command: 'jj-view.edit',
                when: "webviewSection == 'commit' && jj.canEdit",
                group: '2_edit@4',
            },
            {
                command: 'jj-view.duplicate',
                when: "webviewSection == 'commit' && jj.canDuplicate",
                group: '4_changes@1',
            },
            {
                command: 'jj-view.abandon',
                when: "webviewSection == 'commit' && jj.canAbandon",
                group: '4_changes@2',
            },
            {
                command: 'jj-view.absorb',
                when: "webviewSection == 'commit' && jj.canAbsorb",
                group: '4_changes@3',
            },
            {
                command: 'jj-view.upload',
                when: "webviewSection == 'commit' && jj.canUpload",
                group: '3_bookmark@2',
            },
            {
                command: 'jj-view.uploadStack',
                when: "webviewSection == 'commit' && jj.canUpload && !config.jj-view.alwaysUploadStack && jj.codeForgeProvider != 'gerrit'",
                group: '3_bookmark@3',
            },
            {
                command: 'jj-view.rebaseOntoSelected',
                when: "webviewSection == 'commit' && jj.canRebaseOnto",
                group: '5_rebase@1',
            },
            {
                command: 'jj-view.newMergeChange',
                when: "webviewSection == 'commit' && jj.canMerge",
                group: '5_rebase@2',
            },
            {
                command: 'jj-view.setBookmark',
                when: "webviewSection == 'commit'",
                group: '3_bookmark@1',
            },
            {
                command: 'jj-view.advanceBookmark',
                when: "webviewSection == 'commit'",
                group: '3_bookmark@1.5',
            },
            {
                command: 'jj-view.advanceBookmarkAndUpload',
                when: "webviewSection == 'commit' && jj.canUpload",
                group: '3_bookmark@1.6',
            },
            {
                command: 'jj-view.deleteBookmark',
                when: "webviewSection == 'jj.bookmark' && !isRemoteBookmark",
                group: '3_bookmark@2',
            },
            {
                command: 'jj-view.hideCommitAction.newChild',
                when: "webviewSection == 'commitAction' && jj.actionId == 'newChild' && jj.newChildVisible",
                group: '9_visibility_1_hide',
            },
            {
                command: 'jj-view.hideCommitAction.edit',
                when: "webviewSection == 'commitAction' && jj.actionId == 'edit' && jj.editVisible",
                group: '9_visibility_1_hide',
            },
            {
                command: 'jj-view.hideCommitAction.squash',
                when: "webviewSection == 'commitAction' && jj.actionId == 'squash' && jj.squashVisible",
                group: '9_visibility_1_hide',
            },
            {
                command: 'jj-view.hideCommitAction.abandon',
                when: "webviewSection == 'commitAction' && jj.actionId == 'abandon' && jj.abandonVisible",
                group: '9_visibility_1_hide',
            },
            {
                command: 'jj-view.toggleCommitAction.newChild.on',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && jj.commitActionVisible.newChild",
                group: '9_visibility_2_toggle@1',
            },
            {
                command: 'jj-view.toggleCommitAction.newChild.off',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && !jj.commitActionVisible.newChild",
                group: '9_visibility_2_toggle@1',
            },
            {
                command: 'jj-view.toggleCommitAction.edit.on',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && jj.commitActionVisible.edit",
                group: '9_visibility_2_toggle@2',
            },
            {
                command: 'jj-view.toggleCommitAction.edit.off',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && !jj.commitActionVisible.edit",
                group: '9_visibility_2_toggle@2',
            },
            {
                command: 'jj-view.toggleCommitAction.squash.on',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && jj.commitActionVisible.squash",
                group: '9_visibility_2_toggle@3',
            },
            {
                command: 'jj-view.toggleCommitAction.squash.off',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && !jj.commitActionVisible.squash",
                group: '9_visibility_2_toggle@3',
            },
            {
                command: 'jj-view.toggleCommitAction.abandon.on',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && jj.commitActionVisible.abandon",
                group: '9_visibility_2_toggle@4',
            },
            {
                command: 'jj-view.toggleCommitAction.abandon.off',
                when: "(webviewSection == 'commitAction' || webviewSection == 'commitActions') && !jj.commitActionVisible.abandon",
                group: '9_visibility_2_toggle@4',
            },
        ],
        'editor/title/context': [
            {
                command: 'workbench.action.closeActiveEditor',
                group: '1_close@1',
            },
            {
                command: 'workbench.action.closeOtherEditors',
                group: '1_close@2',
            },
            {
                command: 'workbench.action.closeEditorsToTheRight',
                group: '1_close@3',
            },
            {
                command: 'workbench.action.closeAllEditors',
                group: '1_close@4',
            },
            {
                command: 'jj-view.compareFileWith',
                group: 'jj-view@1',
                when: "resourceScheme == 'file'",
            },
            {
                command: 'jj-view.openFile',
                group: 'jj-view@2',
                when: "resourceScheme == 'jj-view' || resourceScheme == 'jj-edit'",
            },
            {
                command: 'jj-view.viewFileAtRevision',
                group: 'jj-view@3',
                when: "resourceScheme == 'file'",
            },
        ],
        'editor/context': [
            {
                command: 'jj-view.squashSelectionIntoParent',
                group: 'jj-view@1',
                when: 'isInDiffEditor && jj.parentMutable',
            },
            {
                command: 'jj-view.compareFileWith',
                group: 'jj-view@2',
                when: "resourceScheme == 'file'",
            },
            {
                command: 'jj-view.viewFileAtRevision',
                group: 'jj-view@3',
                when: "resourceScheme == 'file'",
            },
        ],
    },
};
