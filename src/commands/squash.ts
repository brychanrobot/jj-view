// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { JjService } from '../jj-service';
import { JjScmProvider } from '../jj-scm-provider';
import { collectResourceStates, extractRevision, getErrorMessage } from './command-utils';

export async function squashCommand(scmProvider: JjScmProvider, jj: JjService, args: unknown[]) {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => r.resourceUri.fsPath);

    let revision = extractRevision(args) || '@';

    // Check if we have multiple parents
    const [currentEntry] = await jj.getLog({ revision });
    if (!currentEntry) {
        return;
    }

    if (currentEntry.parents && currentEntry.parents.length > 1) {
        // Multiple parents - prompt for selection
        const parentOptions: vscode.QuickPickItem[] = [];

        for (let i = 0; i < currentEntry.parents.length; i++) {
            let parentRef = currentEntry.parents[i];
            if (typeof parentRef === 'object' && parentRef !== null && 'commit_id' in parentRef) {
                parentRef = (parentRef as { commit_id: string }).commit_id;
            }

            const [parentEntry] = await jj.getLog({ revision: parentRef as string });
            if (parentEntry) {
                const shortId = parentEntry.change_id.substring(0, 8);
                const desc = parentEntry.description?.trim() || '(no description)';
                const shortDesc = desc.split('\n')[0].substring(0, 50);

                parentOptions.push({
                    label: `Parent ${i + 1}: ${shortId}`,
                    description: shortDesc,
                    detail: parentRef as string,
                });
            }
        }

        const selected = await vscode.window.showQuickPick(parentOptions, {
            placeHolder: 'Select which parent to squash into',
        });

        if (!selected) {
            return;
        } // User cancelled

        // Squash from working copy into selected parent
        const hasCurrentDesc = currentEntry.description && currentEntry.description.trim().length > 0;
        const [parentEntry] = await jj.getLog({ revision: selected.detail! });
        const hasParentDesc = parentEntry && parentEntry.description && parentEntry.description.trim().length > 0;

        // Only open editor if squashing ALL changes (paths empty) AND both have descriptions.
        if (paths.length === 0 && hasCurrentDesc && hasParentDesc) {
            await openSquashDescriptionEditor(jj, paths, revision, selected.detail!);
            return;
        }

        // Partial squash or implicit all without conflicting descriptions
        // Always use destination description to avoid launching interactive editor
        await jj.squash(paths, revision, selected.detail!, undefined, true);
    } else {
        // Single parent
        let parentRev = '@-';
        // Use revision- if we are squashing a specific revision
        if (currentEntry && currentEntry.parents && currentEntry.parents.length > 0) {
            const p = currentEntry.parents[0];
            if (typeof p === 'object' && p !== null && 'commit_id' in p) {
                parentRev = (p as { commit_id: string }).commit_id;
            } else {
                parentRev = p as string;
            }
        }

        const hasCurrentDesc = currentEntry && currentEntry.description && currentEntry.description.trim().length > 0;
        const [parentEntry] = await jj.getLog({ revision: parentRev });
        // Be safe with parent entry check (could be root)
        const hasParentDesc = parentEntry && parentEntry.description && parentEntry.description.trim().length > 0;

        if (paths.length === 0 && hasCurrentDesc && hasParentDesc) {
            await openSquashDescriptionEditor(jj, paths, revision, parentRev);
            return;
        }

        // Normal squash - use destination message (-u)
        await jj.squash(paths, revision, parentRev, undefined, true);
    }

    await scmProvider.refresh();
}

async function openSquashDescriptionEditor(jj: JjService, paths: string[], revision: string, parentRev: string) {
    // 1. Get descriptions
    const [currentLog] = await jj.getLog({ revision });
    const [parentLog] = await jj.getLog({ revision: parentRev });

    const currentDesc = currentLog.description || '';
    const parentDesc = parentLog.description || '';

    // 2. Combine descriptions
    const combined = `${parentDesc}\n\n${currentDesc}`.trim();

    // 3. Write to temporary file
    const squashMsgPath = path.join(jj.workspaceRoot, '.jj', 'vscode', 'SQUASH_MSG');
    await fs.mkdir(path.dirname(squashMsgPath), { recursive: true });

    const content = `${combined}\n\n# Please enter the commit message for your changes.\n# Lines starting with '#' will be ignored.\n# When finished, run the "Complete Squash" command or click the checkmark button in the editor title.`;

    await fs.writeFile(squashMsgPath, content);

    // 4. Open in editor
    const doc = await vscode.workspace.openTextDocument(squashMsgPath);
    await vscode.window.showTextDocument(doc);

    // 5. Store pending squash state
    const meta = {
        paths,
        revision,
        parentRev,
    };
    await fs.writeFile(path.join(jj.workspaceRoot, '.jj', 'vscode', 'SQUASH_META.json'), JSON.stringify(meta));
}

export async function completeSquashCommand(scmProvider: JjScmProvider, jj: JjService) {
    // 1. Read metadata
    const metaPath = path.join(jj.workspaceRoot, '.jj', 'vscode', 'SQUASH_META.json');
    const msgPath = path.join(jj.workspaceRoot, '.jj', 'vscode', 'SQUASH_MSG');

    try {
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaContent);
        const { paths, revision, parentRev } = meta;

        // 2. Read message from editor (or file on disk)
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === msgPath);
        let message = '';
        if (doc) {
            if (doc.isDirty) {
                await doc.save();
            }
            message = doc.getText();
        } else {
            message = await fs.readFile(msgPath, 'utf-8');
        }

        // Strip comments
        message = message
            .split('\n')
            .filter((line) => !line.startsWith('#'))
            .join('\n')
            .trim();

        if (message.length === 0) {
            vscode.window.showWarningMessage('Squash message is empty. Aborting.');
            return;
        }

        // 3. Execute Squash
        // We use the stored paths, revision, parentRev
        if (paths && paths.length > 0) {
            await jj.squash(paths, revision, parentRev, message);
        } else {
            await jj.squash([], revision, parentRev, message); // Implicit all
        }

        // Force update description on the parent (@-) because jj squash -m might be finicky
        if (message && message.length > 0) {
            await jj.describe(message, '@-');
        }

        // 4. Cleanup
        await fs.unlink(metaPath).catch(() => {});
        await fs.unlink(msgPath).catch(() => {});

        await scmProvider.refresh();
        vscode.window.showInformationMessage('Squash completed.');
    } catch (e: unknown) {
        const err = e as { code?: string; message: string };
        if (err.code === 'ENOENT') {
            vscode.window.showErrorMessage('No pending squash operation found.');
        } else {
            vscode.window.showErrorMessage(`Failed to complete squash: ${getErrorMessage(e)}`);
        }
    }
}
