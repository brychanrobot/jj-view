/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { extractRevision, isCurrentWorkingCopyResourceGroup, showJjError, withDelayedProgress } from './command-utils';

const MAX_LISTED = 10;

export async function abandonDescendantsCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    let revision: string | undefined;

    // 1. Check if triggered from Working Copy header
    if (args.some((arg) => isCurrentWorkingCopyResourceGroup(arg))) {
        revision = '@';
    } else {
        // 2. Check explicit argument (e.g. context menu click)
        revision = extractRevision(args);

        // 3. Check selection
        if (!revision) {
            const selectedRevisions = scmProvider.getSelectedCommitIds();
            if (selectedRevisions.length > 0) {
                revision = selectedRevisions[0];
            }
        }

        // 4. Prompt the user
        if (!revision) {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter revision to abandon descendants of',
                placeHolder: 'Revision ID (e.g. @, change_id)',
            });
            if (input) {
                revision = input;
            }
        }
    }

    if (!revision) {
        return;
    }

    const descendants = await jj.getDescendants(revision);
    const count = descendants.length;

    const lines: string[] = [];
    const shown = descendants.slice(0, MAX_LISTED);
    for (const d of shown) {
        const desc = d.description || '(no description)';
        lines.push(`  ${d.changeId}  ${desc}`);
    }
    if (count > MAX_LISTED) {
        lines.push(`  ...and ${count - MAX_LISTED} more`);
    }

    const label =
        count === 0
            ? `${revision}`
            : count === 1
              ? `${revision} and 1 descendant`
              : `${revision} and ${count} descendants`;

    const choice = await vscode.window.showWarningMessage(
        `Abandon ${label}?\n\n${lines.join('\n')}`,
        { modal: true },
        'Abandon',
    );

    if (choice !== 'Abandon') {
        return;
    }

    try {
        await withDelayedProgress('Abandoning descendants...', jj.abandon([`${revision}::`]));
        await scmProvider.refresh();
        vscode.window.showInformationMessage(`Abandoned ${label}.`);
    } catch (e: unknown) {
        await showJjError(e, 'Failed to abandon descendants', jj, scmProvider.outputChannel);
    }
}
