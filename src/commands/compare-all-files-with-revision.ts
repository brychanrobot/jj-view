/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from '../jj-service';
import { createRevisionUri, Uri } from '../uri-utils';
import type { JjLoggerChannel } from '../utils/output-channel';
import { extractRevision, promptForRevision, RevisionQuery, showJjError, withDelayedProgress } from './command-utils';

export async function compareAllFilesWithRevisionCommand(
    jj: JjService,
    outputChannel: JjLoggerChannel,
    ...args: unknown[]
): Promise<void> {
    try {
        let revision = extractRevision(args);
        if (!revision) {
            revision = await promptForRevision(jj, {
                placeHolder: 'Select an ancestor to compare with all files',
                emptyPrompt: 'Enter revision to compare with all files',
                revisionQuery: RevisionQuery.ancestorsExcluding('@'),
            });
        }

        if (!revision) {
            return;
        }

        const rev = revision;

        await withDelayedProgress(
            `Comparing ${rev} with all files...`,
            (async (): Promise<void> => {
                const changes = await jj.getChangesBetween(rev, '@');

                if (changes.length === 0) {
                    vscode.window.showInformationMessage(`No differences found between ${rev} and working copy.`);
                    return;
                }

                const resources: [Uri, Uri][] = [];
                for (const entry of changes) {
                    const isAdded = entry.status === 'added';
                    const isDeleted = entry.status === 'deleted';

                    const leftPath = entry.oldPath || entry.path;
                    const rightPath = entry.path;

                    const leftUri = createRevisionUri(jj.workspaceRoot, leftPath, isAdded ? 'none' : rev);
                    const rightUri = isDeleted
                        ? createRevisionUri(jj.workspaceRoot, rightPath, 'none')
                        : Uri.file(path.join(jj.workspaceRoot, rightPath));

                    resources.push([leftUri, rightUri]);
                }

                const title = `Compare ${rev} with Working Copy`;
                const resourceTuples = resources.map(([original, modified]) => [modified, original, modified]);
                await vscode.commands.executeCommand('vscode.changes', title, resourceTuples);
            })(),
        );
    } catch (err: unknown) {
        await showJjError(err, 'Failed to open comparison', jj, outputChannel);
    }
}
