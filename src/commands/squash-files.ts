/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import {
    collectResourceStates,
    extractRevision,
    pickAncestor,
    showJjError,
    withDelayedProgress,
} from './command-utils';

/**
 * Command to squash whole file changes from the working copy into its parent.
 */
export async function squashFilesIntoParentCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => r.resourceUri.fsPath);

    if (paths.length === 0) {
        return;
    }

    const revision = extractRevision(args) || '@';

    try {
        await withDelayedProgress(
            'Squashing file(s) into parent...',
            jj.squashRevision({ paths, revision, useDestinationMessage: true }),
        );
        await scmProvider.refresh({ reason: 'after squash file(s) into parent' });
    } catch (e: unknown) {
        await showJjError(e, 'Error squashing file(s) into parent', jj, scmProvider.outputChannel);
    }
}

/**
 * Command to squash whole file changes from a revision into a chosen ancestor.
 */
export async function squashFilesIntoAncestorCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => r.resourceUri.fsPath);

    if (paths.length === 0) {
        return;
    }

    const revision = extractRevision(args) || '@';

    try {
        const selectedAncestorRev = await pickAncestor(jj, revision);
        if (!selectedAncestorRev) {
            return;
        }

        await withDelayedProgress(
            'Squashing file(s) into ancestor...',
            jj.squashRevision({ paths, revision, intoRevision: selectedAncestorRev, useDestinationMessage: true }),
        );
        await scmProvider.refresh({ reason: 'after squash file(s) into ancestor' });
    } catch (e: unknown) {
        await showJjError(e, 'Error squashing file(s) into ancestor', jj, scmProvider.outputChannel);
    }
}

/**
 * Command to squash whole file changes from a revision into one of its children.
 */
export async function squashFilesIntoChildCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => r.resourceUri.fsPath);

    if (paths.length === 0) {
        return;
    }

    const revision = extractRevision(args) || '@';

    try {
        const children = await jj.getChildren(revision);
        let targetChild: string | undefined;

        if (children.length === 0) {
            const revDisplay = revision === '@' ? 'the working copy' : revision;
            vscode.window.showErrorMessage(`No child commits to squash changes into for ${revDisplay}.`);
            return;
        } else if (children.length === 1) {
            targetChild = children[0];
        } else {
            targetChild = await vscode.window.showQuickPick(children, {
                placeHolder: `Select child commit for ${revision}`,
            });
        }

        if (!targetChild) {
            return;
        }

        await withDelayedProgress(
            'Squashing file(s) into child...',
            jj.squashRevision({ paths, revision, intoRevision: targetChild }),
        );
        await scmProvider.refresh({ reason: 'after squash file(s) into child' });
    } catch (e: unknown) {
        await showJjError(e, 'Error squashing file(s) into child', jj, scmProvider.outputChannel);
    }
}
