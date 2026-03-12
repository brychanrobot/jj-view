/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { collectResourceStates, extractRevision, showJjError, withDelayedProgress } from './command-utils';

export async function squashIntoCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => r.resourceUri.fsPath);

    let revision = extractRevision(args) || '@';

    try {
        // Fetch up to 10 mutable ancestors for the given revision
        const maxMutableAncestors = vscode.workspace.getConfiguration('jj-view').get<number>('maxMutableAncestors', 10);
        const limit = maxMutableAncestors + 1;

        // Fetch linear chain from this revision
        const commitIds = await jj.getLogIds({ revision: `(::${revision} & mutable())`, limit });
        if (commitIds.length <= 1) {
            vscode.window.showInformationMessage('No mutable ancestors available to squash into.');
            return;
        }

        const entries = await Promise.all(commitIds.map(id => jj.getLog({ revision: id })));
        const linearAncestors = entries.map(e => e[0]).filter(Boolean);

        // Remove the current revision itself from the selection options
        const ancestorsToChoose = linearAncestors.slice(1);

        if (ancestorsToChoose.length === 0) {
            vscode.window.showInformationMessage('No mutable ancestors available to squash into.');
            return;
        }

        const options: vscode.QuickPickItem[] = ancestorsToChoose.map((entry) => {
            const shortId = entry.change_id_shortest || entry.change_id.substring(0, 8);
            const desc = entry.description?.trim() || '(no description)';
            const shortDesc = desc.split('\n')[0].substring(0, 50);

            // index + 1 corresponds to @-1, @-2, etc., relative to the current revision
            return {
                label: shortId,
                description: shortDesc,
                detail: entry.commit_id,
            };
        });

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select which ancestor to squash into',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        if (!selected) {
            return;
        } // User cancelled

        const selectedAncestorRev = selected.detail!;

        // Perform the squash using --into
        await withDelayedProgress('Squashing...', jj.squash(paths, revision, selectedAncestorRev, undefined, true));

        await scmProvider.refresh({ reason: 'after squash into ancestor' });
    } catch (e: unknown) {
        showJjError(e, 'Error squashing into ancestor', scmProvider.outputChannel);
    }
}
