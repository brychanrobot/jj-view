/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { JjScmProvider } from '../jj-scm-provider';
import type { JjService } from '../jj-service';
import { extractRevision, pickAncestor, showJjError, withDelayedProgress } from './command-utils';

interface SquashMeta {
    revision: string;
    parentRev: string;
}

function isSquashMeta(obj: unknown): obj is SquashMeta {
    return (
        !!obj &&
        typeof obj === 'object' &&
        'revision' in obj &&
        'parentRev' in obj &&
        typeof (obj as Record<string, unknown>).revision === 'string' &&
        typeof (obj as Record<string, unknown>).parentRev === 'string'
    );
}

/**
 * Command to squash the entire revision into its parent.
 */
export async function squashRevisionIntoParentCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const revision = extractRevision(args) || '@';

    // Check if we have multiple parents
    const [sourceEntry] = await jj.getLog({ revision });
    if (!sourceEntry) {
        return;
    }

    try {
        let targetParent: string;

        if (sourceEntry.parents && sourceEntry.parents.length > 1) {
            // Multiple parents - prompt for selection
            const parentOptions: vscode.QuickPickItem[] = [];

            for (let i = 0; i < sourceEntry.parents.length; i++) {
                const parentRef = sourceEntry.parents[i].commit_id;

                const [parentEntry] = await jj.getLog({ revision: parentRef });
                if (parentEntry) {
                    const shortId = parentEntry.change_id_shortest || parentEntry.change_id.substring(0, 8);
                    const desc = parentEntry.description?.trim() || '(no description)';
                    const shortDesc = desc.split('\n')[0].substring(0, 50);

                    parentOptions.push({
                        label: `Parent ${i + 1}: ${shortId}`,
                        description: shortDesc,
                        detail: parentRef,
                    });
                }
            }

            const selected = await vscode.window.showQuickPick(parentOptions, {
                placeHolder: 'Select which parent to squash into',
            });

            if (!selected?.detail) {
                return;
            } // User cancelled

            targetParent = selected.detail;
        } else {
            // Single parent
            if (!sourceEntry.parents || sourceEntry.parents.length === 0) {
                vscode.window.showErrorMessage('Cannot squash a root revision.');
                return;
            }
            targetParent = sourceEntry.parents[0].commit_id;
        }

        await performSquashRevision(scmProvider, jj, revision, targetParent, sourceEntry.description);

        await scmProvider.refresh({ reason: 'after squash revision into parent' });
    } catch (e: unknown) {
        await showJjError(e, 'Error squashing revision into parent', jj, scmProvider.outputChannel);
    }
}

/**
 * Command to squash the entire revision into a chosen ancestor.
 */
export async function squashRevisionIntoAncestorCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const revision = extractRevision(args) || '@';

    try {
        const selectedAncestorRev = await pickAncestor(jj, revision);
        if (!selectedAncestorRev) {
            return;
        }

        const [sourceEntry] = await jj.getLog({ revision });
        await performSquashRevision(scmProvider, jj, revision, selectedAncestorRev, sourceEntry?.description);
        await scmProvider.refresh({ reason: 'after squash revision into ancestor' });
    } catch (e: unknown) {
        await showJjError(e, 'Error squashing revision into ancestor', jj, scmProvider.outputChannel);
    }
}

const inProgressCompletions = new Set<string>();

/**
 * Checks if a squash operation is currently being completed for the given provider.
 */
export function isSquashInProgress(scmProvider: JjScmProvider): boolean {
    return inProgressCompletions.has(scmProvider.getSquashStorageDir());
}

/**
 * Performs the squash operation, handling descriptions and potentially opening an editor.
 */
async function performSquashRevision(
    scmProvider: JjScmProvider,
    jj: JjService,
    revision: string,
    intoRevision: string,
    sourceDescription?: string,
) {
    const hasSourceDesc = sourceDescription && sourceDescription.trim().length > 0;
    const [parentEntry] = await jj.getLog({ revision: intoRevision });
    if (!parentEntry) {
        throw new Error(`Failed to fetch log for revision ${intoRevision}`);
    }
    const parentDescription = parentEntry.description || '';
    const hasParentDesc = parentDescription.trim().length > 0;

    // Only open editor if both have descriptions.
    if (hasSourceDesc && hasParentDesc) {
        await openSquashDescriptionEditor(
            scmProvider,
            revision,
            sourceDescription || '',
            intoRevision,
            parentDescription,
        );
        return;
    }

    // JJ will pick the non-empty description if only one exists.
    await withDelayedProgress('Squashing revision...', jj.squashRevision({ revision, intoRevision }));
}

async function openSquashDescriptionEditor(
    scmProvider: JjScmProvider,
    revision: string,
    sourceDesc: string,
    parentRev: string,
    parentDesc: string,
) {
    // 1. Combine descriptions
    const combined = `${parentDesc.trim()}\n\n${sourceDesc.trim()}`;

    // 3. Write to temporary file
    const storageDir = scmProvider.getSquashStorageDir();
    const squashMsgPath = path.join(storageDir, 'SQUASH_MSG');
    await fs.mkdir(storageDir, { recursive: true });

    const content = `${combined}\n\nJJ: Please enter the commit message for your changes.\nJJ: Lines starting with "JJ:" will be ignored.\nJJ: When finished, save this file to complete the squash, or click the checkmark button in the editor title.`;

    await fs.writeFile(squashMsgPath, content);

    // 4. Open in editor
    const doc = await vscode.workspace.openTextDocument(squashMsgPath);
    await vscode.window.showTextDocument(doc);

    // 5. Store pending squash state
    const meta: SquashMeta = {
        revision,
        parentRev,
    };
    await fs.writeFile(path.join(storageDir, 'SQUASH_META.json'), JSON.stringify(meta));
}

export async function completeSquashRevisionCommand(scmProvider: JjScmProvider, jj: JjService, message: string) {
    const storageDir = scmProvider.getSquashStorageDir();
    const metaPath = path.join(storageDir, 'SQUASH_META.json');
    const msgPath = path.join(storageDir, 'SQUASH_MSG');

    if (inProgressCompletions.has(storageDir)) {
        return;
    }

    inProgressCompletions.add(storageDir);

    try {
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        const metaRaw: unknown = JSON.parse(metaContent);
        if (!isSquashMeta(metaRaw)) {
            throw new Error('Invalid squash metadata.');
        }
        const { revision, parentRev } = metaRaw;

        // Strip comments
        const finalMessage = message
            .split('\n')
            .filter((line) => !line.startsWith('JJ:'))
            .join('\n')
            .trim();

        if (finalMessage.length === 0) {
            vscode.window.showWarningMessage('Squash message is empty. Aborting.');
            return;
        }

        await withDelayedProgress(
            'Squashing revision...',
            jj.squashRevision({ revision, intoRevision: parentRev, message: finalMessage }),
        );

        await scmProvider.refresh({ reason: 'after complete squash revision' });
        vscode.window.showInformationMessage('Squash completed.');
    } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
            vscode.window.showErrorMessage('No pending squash operation found.');
        } else {
            await showJjError(e, 'Failed to complete squash revision', jj, scmProvider.outputChannel);
        }
    } finally {
        await fs.unlink(metaPath).catch(() => {});
        await fs.unlink(msgPath).catch(() => {});

        // Close the editor if it's still open
        const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
        const tab = tabs.find((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === msgPath);
        if (tab) {
            await vscode.window.tabGroups.close(tab);
        }
        inProgressCompletions.delete(storageDir);
    }
}
