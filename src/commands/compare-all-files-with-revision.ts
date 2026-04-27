/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjService } from '../jj-service';
import { encodeJjViewQuery } from '../uri-utils';
import { extractRevision, promptForRevision, showJjError, withDelayedProgress } from './command-utils';

export async function compareAllFilesWithRevisionCommand(
    jj: JjService,
    outputChannel: vscode.OutputChannel,
    ...args: unknown[]
): Promise<void> {
    try {
        let revision = extractRevision(args);
        if (!revision) {
            revision = await promptForRevision(
                jj,
                '@',
                'Select an ancestor to compare with all files',
                'Enter revision to compare with all files',
            );
        }

        if (!revision) {
            return;
        }

        const rev = revision;

        await withDelayedProgress(
            `Comparing ${rev} with all files...`,
            (async (): Promise<void> => {
                const changes = await jj.getChanges(rev, '@');

                if (changes.length === 0) {
                    vscode.window.showInformationMessage(`No differences found between ${rev} and working copy.`);
                    return;
                }

                const resources: [vscode.Uri, vscode.Uri][] = [];
                for (const entry of changes) {
                    const isAdded = entry.status === 'added';
                    const isDeleted = entry.status === 'deleted';

                    const leftPath = entry.oldPath || entry.path;
                    const rightPath = entry.path;

                    const leftUri = vscode.Uri.file(path.join(jj.workspaceRoot, leftPath)).with({
                        scheme: 'jj-view',
                        query: isAdded
                            ? encodeJjViewQuery({ mode: 'revision', revision: 'none' })
                            : encodeJjViewQuery({ mode: 'revision', revision: rev }),
                    });

                    const rightUri = isDeleted
                        ? vscode.Uri.file(path.join(jj.workspaceRoot, rightPath)).with({
                              scheme: 'jj-view',
                              query: encodeJjViewQuery({ mode: 'revision', revision: 'none' }),
                          })
                        : vscode.Uri.file(path.join(jj.workspaceRoot, rightPath));

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
