/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../common/command-context';
import { promptForRevision, showJjError } from '../common/ui-helpers';
import { Uri } from '../uri-utils';
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

export function getSquashStorageDir(workspaceRoot: string): string {
    const normRoot = path.normalize(workspaceRoot.replace(/\\/g, '/')).toLowerCase();
    const hash = crypto.createHash('md5').update(normRoot).digest('hex');
    return path.join(os.tmpdir(), `jj-view-squash-${hash}`);
}

const inProgressCompletions = new Set<string>();

export function isSquashInProgress(workspaceRoot: string): boolean {
    return inProgressCompletions.has(getSquashStorageDir(workspaceRoot));
}

export async function squashRevisionIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashRevisionIntoParentPayload,
): Promise<void> {
    const revision = payload?.revision || '@';

    try {
        const [sourceEntry] = await ctx.repo.jj.getLog({ revision });
        if (!sourceEntry) {
            return;
        }

        let targetParent = payload?.targetParent;

        if (!targetParent) {
            if (sourceEntry.parents && sourceEntry.parents.length > 1) {
                const items = sourceEntry.parents.map((p) => ({
                    label: p.change_id.substring(0, 8),
                    detail: p.commit_id,
                    value: p.commit_id,
                }));

                const selected = await ctx.host.ui.showQuickPick(items, {
                    placeHolder: 'Select which parent to squash into',
                });

                const chosen = selected?.detail || selected?.value;
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
                revisionQuery: RevisionQuery.ancestorsExcluding(revision),
            });
        }
        if (!selectedAncestorRev) {
            return;
        }

        const [sourceEntry] = await ctx.repo.jj.getLog({ revision });
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
    const [parentEntry] = await ctx.repo.jj.getLog({ revision: intoRevision });
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
    const storageDir = getSquashStorageDir(ctx.repo.rootUri.fsPath);
    const squashMsgPath = path.join(storageDir, 'SQUASH_MSG');
    await fs.mkdir(storageDir, { recursive: true });

    const content = `${combined}\n\nJJ: Please enter the commit message for your changes.\nJJ: Lines starting with "JJ:" will be ignored.\nJJ: When finished, save this file to complete the squash, or click the checkmark button in the editor title.`;

    await fs.writeFile(squashMsgPath, content);
    await ctx.host.nav.openFile(Uri.file(squashMsgPath));

    const meta: SquashMeta = {
        revision,
        parentRev,
    };
    await fs.writeFile(path.join(storageDir, 'SQUASH_META.json'), JSON.stringify(meta));
}

export interface CompleteSquashRevisionPayload {
    message?: string;
}

export async function completeSquashRevisionCommand(
    ctx: CommandContext,
    payload?: CompleteSquashRevisionPayload,
): Promise<void> {
    const storageDir = getSquashStorageDir(ctx.repo.rootUri.fsPath);
    const metaPath = path.join(storageDir, 'SQUASH_META.json');
    const msgPath = path.join(storageDir, 'SQUASH_MSG');
    const msgUri = Uri.file(msgPath);

    if (inProgressCompletions.has(storageDir)) {
        return;
    }

    inProgressCompletions.add(storageDir);

    try {
        const metaContent = await fs.readFile(metaPath, 'utf-8');
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
                ctx.host.documents.getOpenDocumentText(msgUri) ?? (await fs.readFile(msgPath, 'utf-8').catch(() => ''));
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
        await fs.unlink(metaPath).catch(() => {});
        await fs.unlink(msgPath).catch(() => {});
        await ctx.host.nav.closeTab(msgUri);
        inProgressCompletions.delete(storageDir);
    }
}
