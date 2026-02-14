import * as vscode from 'vscode';
import { JjStatusEntry } from './jj-types';

export function createDiffUris(
    entry: JjStatusEntry,
    revision: string,
    root: string,
    parentRevision?: string
): { leftUri: vscode.Uri; rightUri: vscode.Uri; resourceUri: vscode.Uri } {
    const resourceUri = revision === '@'
        ? vscode.Uri.joinPath(vscode.Uri.file(root), entry.path)
        : vscode.Uri.joinPath(vscode.Uri.file(root), entry.path).with({ query: `jj-revision=${revision}` });

    // For renames/copies, the left side shows the old path
    let leftPath = resourceUri.path;
    if ((entry.status === 'renamed' || entry.status === 'copied') && entry.oldPath) {
        leftPath = vscode.Uri.joinPath(vscode.Uri.file(root), entry.oldPath).path;
    }

    // For the left side, use explicit parentRevision if provided (required for merge commits,
    // where `revision-` resolves to multiple commits and causes `jj file show` to fail).
    const leftRevision = parentRevision ?? `${revision}-`;
    const leftUri = vscode.Uri.from({
        scheme: 'jj-view',
        path: leftPath,
        query: `revision=${leftRevision}&path=${encodeURIComponent(leftPath)}`,
    });

    const rightUri =
        revision === '@'
            ? resourceUri
            : vscode.Uri.from({
                  scheme: 'jj-view',
                  path: resourceUri.path,
                  query: `revision=${revision}`,
              });

    return { leftUri, rightUri, resourceUri };
}
