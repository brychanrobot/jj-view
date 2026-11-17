/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'pathe';
import type { CommandContext } from '../host/command-context';
import type { HostFs } from '../host/host-system';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import type { Uri } from '../uri-utils';
import { RevisionQuery } from './command-utils';

export interface RestoreFileFromRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

/**
 * Formats a workspace-relative file path as an exact JJ `root-file:"..."` fileset literal
 * so fileset metacharacters (`:`, `*`, `~`, parentheses) and leading dashes are treated as literal path characters.
 */
export function formatRootFileFileset(relPath: string): string {
    let escaped = '';
    for (const ch of relPath) {
        const code = ch.charCodeAt(0);
        if (ch === '\\') {
            escaped += '\\\\';
        } else if (ch === '"') {
            escaped += '\\"';
        } else if (ch === '\t') {
            escaped += '\\t';
        } else if (ch === '\r') {
            escaped += '\\r';
        } else if (ch === '\n') {
            escaped += '\\n';
        } else if (ch === '\0') {
            escaped += '\\0';
        } else if (code < 0x20 || code === 0x7f) {
            escaped += `\\x${code.toString(16).padStart(2, '0')}`;
        } else {
            escaped += ch;
        }
    }
    return `root-file:"${escaped}"`;
}

function isInsideRelativePath(rel: string): boolean {
    return rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) && !/^[a-zA-Z]:(?:$|[/\\])/.test(rel);
}

async function resolveNearestRealPath(filePath: string, fs: HostFs): Promise<string | undefined> {
    let current = filePath;
    const trailing: string[] = [];
    while (current) {
        try {
            const real = await fs.realpath(current);
            return trailing.length > 0 ? path.join(real, ...trailing) : real;
        } catch {
            const parent = path.dirname(current);
            if (!parent || parent === current || /^[a-zA-Z]:([/\\])?$/.test(current)) {
                return undefined;
            }
            trailing.unshift(path.basename(current));
            current = parent;
        }
    }
    return undefined;
}

export async function resolveWorkspaceRelativePath(
    workspaceRoot: string,
    filePath: string,
    fs?: HostFs,
): Promise<string | undefined> {
    const relFromRoot = path.relative(workspaceRoot, filePath);
    if (isInsideRelativePath(relFromRoot)) {
        return relFromRoot;
    }
    if (!fs) {
        return undefined;
    }
    let realRoot = workspaceRoot;
    try {
        realRoot = await fs.realpath(workspaceRoot);
    } catch {
        // Keep original workspaceRoot when realpath is unavailable
    }
    const realFile = await resolveNearestRealPath(filePath, fs);
    if (!realFile) {
        return undefined;
    }
    const relFromReal = path.relative(realRoot, realFile);
    return isInsideRelativePath(relFromReal) ? relFromReal : undefined;
}

export async function restoreFileFromRevisionCommand(
    ctx: CommandContext,
    payload?: RestoreFileFromRevisionPayload,
): Promise<void> {
    try {
        const fileUri = payload?.fileUri;

        if (!fileUri || fileUri.scheme !== 'file' || !fileUri.fsPath) {
            await showJjError(
                ctx.host.ui,
                new Error('No workspace file selected to restore.'),
                'Restore File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        const relPath = await resolveWorkspaceRelativePath(
            ctx.repo.jj.workspaceRoot,
            fileUri.fsPath,
            ctx.host.system?.fs,
        );
        if (relPath === undefined) {
            await showJjError(
                ctx.host.ui,
                new Error('Selected file is outside the repository workspace.'),
                'Restore File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        let isDirectory = relPath === '' || relPath === '.';
        if (!isDirectory && ctx.host.system?.fs) {
            try {
                const resolvedFsPath = path.join(ctx.repo.jj.workspaceRoot, relPath);
                const stat = await ctx.host.system.fs.stat(resolvedFsPath);
                isDirectory = stat.isDirectory();
            } catch {
                // Path does not exist on disk yet (e.g. restoring a deleted file); proceed.
            }
        }

        if (isDirectory) {
            await showJjError(
                ctx.host.ui,
                new Error('Cannot restore a directory. Please select a workspace file.'),
                'Restore File Error',
                ctx.repo.jj,
                ctx.log,
            );
            return;
        }

        const fileName = path.basename(fileUri.fsPath);
        let revision = payload?.revision?.trim() || undefined;
        if (!revision) {
            revision = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: `Select a revision to restore ${fileName} from`,
                emptyPrompt: `Restore ${fileName} from revision`,
                revisionQuery: RevisionQuery.visible(),
                repoRoot: ctx.repo.rootUri,
                nav: ctx.host.nav,
            });
        }

        const targetRevision = revision?.trim();
        if (!targetRevision) {
            return;
        }

        const matches = await ctx.repo.jj.getLog({ revision: targetRevision, limit: 2, omitChanges: true });
        if (matches.length === 0) {
            throw new Error(`No revision found for: ${targetRevision}`);
        }
        if (matches.length > 1) {
            throw new Error(
                `Revision expression "${targetRevision}" matched multiple revisions; specify a single revision.`,
            );
        }
        const resolvedCommitId = matches[0].commit_id;

        await ctx.host.ui.withProgress(`Restoring ${fileName} from ${targetRevision}...`, async () => {
            await ctx.host.documents.saveIfDirty(fileUri);
            await ctx.repo.jj.restore([formatRootFileFileset(relPath)], { from: resolvedCommitId });
        });
        await ctx.repo.refresh({ reason: 'restoreFileFrom' });
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Failed to restore file from revision', ctx.repo.jj, ctx.log);
    }
}
