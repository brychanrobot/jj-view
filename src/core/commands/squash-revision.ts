/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import { z } from 'zod';
import type { CommandContext } from '../host/command-context';
import { createQuickPickHighlightTracker, promptForRevision, showJjError } from '../host/ui-helpers';
import { fnv1aHash, Uri } from '../uri-utils';
import { RevisionQuery } from './command-utils';

const SquashMetaSchema = z.object({
    revision: z.string(),
    parentRev: z.string(),
});
type SquashMeta = z.infer<typeof SquashMetaSchema>;

export interface SquashRevisionIntoParentPayload {
    revision?: string;
    targetParent?: string;
}

export interface SquashRevisionIntoAncestorPayload {
    revision?: string;
    ancestorRevision?: string;
}

function getDefaultTempDir(): string {
    if (typeof process !== 'undefined' && process.env) {
        return process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
    }
    return '/tmp';
}

export function getSquashStorageDir(workspaceRoot: string, tempDir?: string): string {
    const normRoot = path.normalize(workspaceRoot).toLowerCase();
    const hash = fnv1aHash(normRoot);
    return path.join(tempDir ?? getDefaultTempDir(), `jj-view-squash-${hash}`);
}

const inProgressCompletions = new Set<string>();

export function isSquashInProgress(workspaceRoot: string): boolean {
    const normRoot = path.normalize(workspaceRoot).toLowerCase();
    return inProgressCompletions.has(normRoot);
}

export async function squashRevisionIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashRevisionIntoParentPayload,
): Promise<void> {
    const revision = payload?.revision || '@';

    try {
        const [sourceEntry] = await ctx.repo.jj.getLog({ revision, omitChanges: true });
        if (!sourceEntry) {
            return;
        }

        let targetParent = payload?.targetParent;

        if (!targetParent) {
            if (sourceEntry.parents && sourceEntry.parents.length > 1) {
                const items = sourceEntry.parents.map((p) => ({
                    label: p.change_id.substring(0, 8),
                    description: p.commit_id.substring(0, 8),
                    value: p.commit_id,
                    changeId: p.change_id,
                }));

                const tracker = createQuickPickHighlightTracker({
                    repoRoot: ctx.repo.rootUri,
                    nav: ctx.host.nav,
                    getItemRevision: (item) => item.changeId ?? String(item.value ?? item.label),
                });

                let selected: (typeof items)[number] | undefined;

                try {
                    selected = await ctx.host.ui.showQuickPick(items, {
                        placeHolder: 'Select which parent to squash into',
                        matchOnDescription: true,
                        onDidChangeActive: tracker.onDidChangeActive,
                        onDidChangeValue: tracker.onDidChangeValue,
                    });
                } finally {
                    tracker.cleanup();
                }

                const chosen = selected?.value;
                if (!chosen) {
                    return;
                }

                targetParent = chosen;
            } else {
                if (!sourceEntry.parents || sourceEntry.parents.length === 0) {
                    await showJjError(
                        ctx.host.ui,
                        new Error('Cannot squash a root revision.'),
                        'Squash Revision Error',
                        ctx.repo.jj,
                        ctx.log,
                    );
                    return;
                }
                targetParent = sourceEntry.parents[0].commit_id;
            }
        }

        if (!targetParent) {
            return;
        }

        await performSquashRevision(ctx, revision, targetParent, sourceEntry.description);
        await ctx.repo.refresh({ reason: 'after squash revision into parent' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing revision into parent', ctx.repo.jj, ctx.log);
    }
}

export async function squashRevisionIntoAncestorCommand(
    ctx: CommandContext,
    payload?: SquashRevisionIntoAncestorPayload,
): Promise<void> {
    const revision = payload?.revision || '@';

    try {
        let selectedAncestorRev = payload?.ancestorRevision;
        if (!selectedAncestorRev) {
            selectedAncestorRev = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: 'Select which ancestor to squash into',
                revisionQuery: RevisionQuery.mutableAncestorsExcluding(revision),
                repoRoot: ctx.repo.rootUri,
                nav: ctx.host.nav,
            });
        }
        if (!selectedAncestorRev) {
            return;
        }

        const [sourceEntry] = await ctx.repo.jj.getLog({ revision, omitChanges: true });
        await performSquashRevision(ctx, revision, selectedAncestorRev, sourceEntry?.description);
        await ctx.repo.refresh({ reason: 'after squash revision into ancestor' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing revision into ancestor', ctx.repo.jj, ctx.log);
    }
}

async function performSquashRevision(
    ctx: CommandContext,
    revision: string,
    intoRevision: string,
    sourceDescription?: string,
) {
    const hasSourceDesc = sourceDescription && sourceDescription.trim().length > 0;
    const [parentEntry] = await ctx.repo.jj.getLog({ revision: intoRevision, omitChanges: true });
    if (!parentEntry) {
        throw new Error(`Failed to fetch log for revision ${intoRevision}`);
    }
    const parentDescription = parentEntry.description || '';
    const hasParentDesc = parentDescription.trim().length > 0;

    if (hasSourceDesc && hasParentDesc) {
        await openSquashDescriptionEditor(ctx, revision, sourceDescription || '', intoRevision, parentDescription);
        return;
    }

    await ctx.host.ui.withProgress('Squashing revision...', () =>
        ctx.repo.jj.squashRevision({ revision, intoRevision }),
    );
}

async function openSquashDescriptionEditor(
    ctx: CommandContext,
    revision: string,
    sourceDesc: string,
    parentRev: string,
    parentDesc: string,
) {
    const combined = `${parentDesc.trim()}\n\n${sourceDesc.trim()}`;
    const hostFs = ctx.host.system?.fs;
    if (!hostFs) {
        throw new Error('Host filesystem not available');
    }

    const storageDir = getSquashStorageDir(ctx.repo.rootUri.fsPath, hostFs.tempDir);
    const squashMsgPath = path.join(storageDir, 'SQUASH_MSG');
    await hostFs.mkdir(storageDir, { recursive: true });

    const content = `${combined}\n\nJJ: Please enter the commit message for your changes.\nJJ: Lines starting with "JJ:" will be ignored.\nJJ: When finished, save this file to complete the squash, or click the checkmark button in the editor title.`;

    await hostFs.writeTextFile(squashMsgPath, content);
    await ctx.host.nav.openFile(Uri.file(squashMsgPath));

    const meta: SquashMeta = {
        revision,
        parentRev,
    };
    await hostFs.writeTextFile(path.join(storageDir, 'SQUASH_META.json'), JSON.stringify(meta));
}

export interface CompleteSquashRevisionPayload {
    message?: string;
}

export async function completeSquashRevisionCommand(
    ctx: CommandContext,
    payload?: CompleteSquashRevisionPayload,
): Promise<void> {
    const hostFs = ctx.host.system?.fs;
    if (!hostFs) {
        throw new Error('Host filesystem not available');
    }

    const normRoot = path.normalize(ctx.repo.rootUri.fsPath).toLowerCase();
    const storageDir = getSquashStorageDir(ctx.repo.rootUri.fsPath, hostFs.tempDir);
    const metaPath = path.join(storageDir, 'SQUASH_META.json');
    const msgPath = path.join(storageDir, 'SQUASH_MSG');
    const msgUri = Uri.file(msgPath);

    if (inProgressCompletions.has(normRoot)) {
        return;
    }

    inProgressCompletions.add(normRoot);

    try {
        const metaContent = await hostFs.readTextFile(metaPath);
        const parsed = JSON.parse(metaContent);
        const validation = SquashMetaSchema.safeParse(parsed);
        if (!validation.success) {
            throw new Error('Invalid squash metadata.');
        }
        const { revision, parentRev } = validation.data;

        await ctx.host.documents.saveIfDirty(msgUri);

        let rawMessage = payload?.message;
        if (!rawMessage || rawMessage.trim().length === 0) {
            rawMessage =
                ctx.host.documents.getOpenDocumentText(msgUri) ?? (await hostFs.readTextFile(msgPath).catch(() => ''));
        }

        const finalMessage = rawMessage
            .split('\n')
            .filter((line) => !line.startsWith('JJ:'))
            .join('\n')
            .trim();

        if (finalMessage.length === 0) {
            await ctx.host.ui.showWarning('Squash message is empty. Aborting.');
            return;
        }

        await ctx.host.ui.withProgress('Squashing revision...', () =>
            ctx.repo.jj.squashRevision({ revision, intoRevision: parentRev, message: finalMessage }),
        );

        await ctx.repo.refresh({ reason: 'after complete squash revision' });
        await ctx.host.ui.showInformation('Squash completed.');
    } catch (e: unknown) {
        if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
            await showJjError(ctx.host.ui, e, 'No pending squash operation found.', ctx.repo.jj, ctx.log);
        } else {
            await showJjError(ctx.host.ui, e, 'Failed to complete squash revision.', ctx.repo.jj, ctx.log);
        }
    } finally {
        await hostFs.unlink(metaPath).catch(() => {});
        await hostFs.unlink(msgPath).catch(() => {});
        await ctx.host.nav.closeTab(msgUri);
        inProgressCompletions.delete(normRoot);
    }
}
