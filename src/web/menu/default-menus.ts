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
            command: 'jj-view.commit',
            title: 'Commit',
            category: 'JJ View',
            icon: '$(check)',
        },
        {
            command: 'jj-view.refresh',
            title: 'Refresh',
            category: 'JJ View',
            icon: '$(refresh)',
        },
        {
            command: 'jj-view.manageAuth',
            title: 'Manage Code Forge Authentication',
            category: 'JJ View',
            icon: '$(key)',
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
            command: 'jj-view.restore',
            title: 'Restore',
            category: 'JJ View',
            icon: '$(discard)',
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
            command: 'jj-view.absorb',
            title: 'Absorb',
            category: 'JJ View',
            icon: '$(cloud-upload)',
        },
        {
            command: 'jj-view.showMultiFileDiff',
            title: 'Show Multi-File Diff',
            category: 'JJ View',
            icon: '$(diff)',
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
            command: 'jj-view.squashFilesIntoParent',
            title: 'Squash File into Parent',
            category: 'JJ View',
            icon: '$(arrow-down)',
        },
        {
            command: 'jj-view.squashFilesIntoAncestor',
            title: 'Squash File into Ancestor...',
            category: 'JJ View',
            icon: '$(jj-icon-squash-into)',
        },
        {
            command: 'jj-view.squashFilesIntoChild',
            title: 'Squash File into Child',
            category: 'JJ View',
            icon: '$(arrow-up)',
        },
        {
            command: 'jj-view.showDetails',
            title: 'Show Details',
            category: 'JJ View',
            icon: '$(info)',
        },
        {
            command: 'jj-view.openMergeEditor',
            title: 'Open Merge Editor',
            category: 'JJ View',
            icon: '$(git-merge)',
        },
    ],
    menus: {
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
    },
};
