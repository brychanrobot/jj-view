/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { ScmContextValue } from './jj-context-keys';
import type { JjStatusEntry } from './jj-types';
import { createDiffUris, toFileUri, type Uri } from './uri-utils';

export interface ResourceCommand {
    command: string;
    title: string;
    arguments?: unknown[];
}

export interface ResourceDecorations {
    faded?: boolean;
    strikeThrough?: boolean;
}

export interface JjResourceState {
    resourceUri: Uri;
    command?: ResourceCommand;
    decorations?: ResourceDecorations;
    contextValue?: string;
    leftUri?: Uri;
    rightUri?: Uri;
    diffTitle?: string;
    revision: string;
}

export function createJjResourceState(
    entry: JjStatusEntry,
    revision: string,
    root: string,
    options: {
        editable?: boolean;
        workingCopyChangeId?: string;
        squashable?: boolean;
        multipleAncestors?: boolean;
        openDiffOnClick?: boolean;
        hasChild?: boolean;
        inConflictGroup?: boolean;
    } = {},
): JjResourceState {
    const isCurrentWorkingCopy = revision === '@' || revision === options.workingCopyChangeId;
    const { leftUri, rightUri, resourceUri } = createDiffUris(entry, revision, root, options);

    const openDiffOnClick = options.openDiffOnClick ?? true;
    const isDeleted = entry.status === 'deleted';

    const diffTitle = `${entry.path} (${isCurrentWorkingCopy ? 'Working Copy' : revision})`;

    const diffCommand: ResourceCommand = {
        command: 'vscode.diff',
        title: 'Open Changes',
        arguments: [leftUri, rightUri, diffTitle],
    };

    const command: ResourceCommand =
        entry.conflicted && options.inConflictGroup
            ? {
                  command: 'jj-view.openMergeEditor',
                  title: 'Open 3-Way Merge',
                  arguments: [{ resourceUri }],
              }
            : openDiffOnClick || isDeleted
              ? diffCommand
              : {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [toFileUri(resourceUri)],
                };

    const flags: string[] = [];

    flags.push(ScmContextValue.ResourceAllowRestore);

    if (entry.conflicted && options.inConflictGroup) {
        flags.push(ScmContextValue.ResourceAllowOpenMergeEditor);
    } else {
        flags.push(ScmContextValue.ResourceAllowOpen);
        if (options.squashable) {
            flags.push(ScmContextValue.ResourceAllowSquashIntoParent);
            if (options.multipleAncestors) {
                flags.push(ScmContextValue.ResourceAllowSquashIntoAncestor);
            }
        }
        if (!isCurrentWorkingCopy || options.hasChild) {
            flags.push(ScmContextValue.ResourceAllowSquashIntoChild);
        }
    }

    const contextValue = flags.join(' ');

    return {
        resourceUri,
        command,
        leftUri,
        rightUri,
        diffTitle,
        decorations: {
            faded: false,
            strikeThrough: entry.status === 'deleted',
        },
        contextValue,
        revision,
    };
}
