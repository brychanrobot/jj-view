
import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { createDiffUris } from '../uri-utils';
import { extractRevision, getErrorMessage, withDelayedProgress } from './command-utils';

export async function showMultiFileDiffCommand(
    jj: JjService,
    ...args: unknown[]
): Promise<void> {
    try {
        const revision = extractRevision(args) || '@';
        
        await withDelayedProgress(`Preparing multi-file diff for ${revision}...`, (async (): Promise<void> => {
            // Resolve to concrete change ID so both diff sides use the jj-view content provider
            const [logEntry] = await jj.getLog({ revision, limit: 1 });
            const changeId = logEntry?.change_id ?? revision;

            const [changes, description] = await Promise.all([
                jj.getChanges(changeId),
                jj.getDescription(changeId),
            ]);
            
            if (changes.length === 0) {
                vscode.window.showInformationMessage(`No changes found in revision ${changeId}.`);
                return;
            }

            const resources: [vscode.Uri, vscode.Uri][] = [];
            for (const entry of changes) {
                const { leftUri, rightUri } = createDiffUris(entry, changeId, jj.workspaceRoot);
                resources.push([leftUri, rightUri]);
            }

            /*
             * vscode.changes expects: (title: string, resources: [label, original, modified][])
             * Each tuple is [labelUri, originalUri, modifiedUri] where:
             *   - label: display identifier for the file in the multi-diff editor
             *   - original: left-side (parent revision)
             *   - modified: right-side (current revision)
             */
            const firstLine = description.split('\n')[0].trim();
            const shortId = changeId.slice(0, 8);
            const title = firstLine ? `${shortId}: ${firstLine}` : `Changes in ${shortId}`;
            const resourceTuples = resources.map(([original, modified]) => [modified, original, modified]);
            await vscode.commands.executeCommand('vscode.changes', title, resourceTuples);
        })());

    } catch (err) {
        vscode.window.showErrorMessage(`Failed to open multi-file diff: ${getErrorMessage(err)}`);
    }
}

