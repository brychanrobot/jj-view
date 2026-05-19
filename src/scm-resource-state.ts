/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';
import { ScmContextValue } from './jj-context-keys';
import type { JjStatusEntry } from './jj-types';
import { createDiffUris } from './uri-utils';

export interface JjResourceState extends vscode.SourceControlResourceState {
    leftUri?: vscode.Uri;
    rightUri?: vscode.Uri;
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
    } = {},
): JjResourceState {
    const isCurrentWorkingCopy = revision === '@' || revision === options.workingCopyChangeId;
    const { leftUri, rightUri, resourceUri } = createDiffUris(entry, revision, root, options);

    const openDiffOnClick = options.openDiffOnClick ?? true;
    const isDeleted = entry.status === 'removed' || entry.status === 'deleted';

    const diffTitle = `${entry.path} (${isCurrentWorkingCopy ? 'Working Copy' : revision})`;

    const diffCommand: vscode.Command = {
        command: 'vscode.diff',
        title: 'Open Changes',
        arguments: [leftUri, rightUri, diffTitle],
    };

    const command: vscode.Command = entry.conflicted
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
                arguments: [resourceUri.with({ query: '' })],
            };

    const flags: string[] = [];

    flags.push(ScmContextValue.ResourceAllowRestore);

    if (entry.conflicted) {
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
            tooltip: entry.conflicted ? 'Conflicted' : entry.status,
            faded: false,
            strikeThrough: entry.status === 'removed',
        },
        contextValue,
        revision,
    };
}
