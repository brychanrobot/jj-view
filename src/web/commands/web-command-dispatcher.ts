/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScmModel } from '../../core/scm-model';
import type { JjResourceState } from '../../core/scm-resource-state';
import type { Uri } from '../../core/uri-utils';
import { toError } from '../../utils/error-utils';

export interface WebGroupPayload {
    readonly groupId: string;
    readonly ancestor?: {
        readonly entry: {
            readonly commit_id: string;
            readonly change_id?: string;
        };
    };
    readonly revision?: string;
}

export interface WebCommandContext {
    readonly scmModel: ScmModel;
    readonly onOpenDiff?: (leftUri?: Uri, rightUri?: Uri, title?: string) => void;
    readonly onOpenFile?: (uri: Uri) => void;
    readonly onShowDetails?: (revision: string) => void;
    readonly onShowMultiFileDiff?: (revision: string) => void;
    readonly onPrompt?: (message: string, defaultValue?: string) => Promise<string | undefined>;
    readonly onConfirm?: (message: string) => Promise<boolean>;
    readonly onError?: (error: Error) => void;
}

export class WebCommandDispatcher {
    constructor(private readonly _context: WebCommandContext) {}

    public async execute(command: string, payload?: unknown): Promise<void> {
        const scm = this._context.scmModel;

        try {
            switch (command) {
                case 'jj-view.new': {
                    await scm.jj.new();
                    await scm.refresh({ reason: 'command:new' });
                    return;
                }

                case 'jj-view.refresh': {
                    await scm.refresh({ forceSnapshot: true, reason: 'command:refresh' });
                    return;
                }

                case 'jj-view.commit': {
                    const message = typeof payload === 'string' ? payload : scm.snapshot?.description || '';
                    await scm.jj.commit(message);
                    await scm.refresh({ reason: 'command:commit' });
                    return;
                }

                case 'jj-view.setDescription': {
                    const message = typeof payload === 'string' ? payload : scm.snapshot?.description || '';
                    await scm.setDescription(message);
                    return;
                }

                case 'jj-view.abandon': {
                    let targetRev: string | undefined;
                    if (payload && typeof payload === 'object') {
                        if ('ancestor' in payload && (payload as WebGroupPayload).ancestor) {
                            targetRev = (payload as WebGroupPayload).ancestor?.entry.commit_id;
                        } else if ('revision' in payload) {
                            targetRev = (payload as { revision: string }).revision;
                        }
                    }
                    if (!targetRev) {
                        targetRev = scm.snapshot?.currentEntry?.commit_id;
                    }
                    if (!targetRev) {
                        return;
                    }

                    if (this._context.onConfirm) {
                        const confirmed = await this._context.onConfirm(
                            `Are you sure you want to abandon revision ${targetRev.slice(0, 8)}?`,
                        );
                        if (!confirmed) {
                            return;
                        }
                    }

                    await scm.abandon([targetRev]);
                    await scm.refresh({ reason: 'command:abandon' });
                    return;
                }

                case 'jj-view.restore': {
                    if (payload && typeof payload === 'object' && 'resourceUri' in payload) {
                        const item = payload as JjResourceState;
                        const path = item.resourceUri.path.replace(/^\//, '');
                        await scm.restore([path]);
                    }
                    return;
                }

                case 'jj-view.squashRevisionIntoParent': {
                    let targetRev = '@';
                    if (payload && typeof payload === 'object' && 'ancestor' in payload) {
                        targetRev = (payload as WebGroupPayload).ancestor?.entry.commit_id || '@';
                    }
                    await scm.jj.squashRevision({ revision: targetRev });
                    await scm.refresh({ reason: 'command:squashRevisionIntoParent' });
                    return;
                }

                case 'jj-view.squashFilesIntoParent': {
                    if (payload && typeof payload === 'object' && 'resourceUri' in payload) {
                        const item = payload as JjResourceState;
                        const path = item.resourceUri.path.replace(/^\//, '');
                        await scm.jj.squashRevision({
                            revision: item.revision || '@',
                            paths: [path],
                        });
                        await scm.refresh({ reason: 'command:squashFilesIntoParent' });
                    }
                    return;
                }

                case 'jj-view.absorb': {
                    await scm.jj.absorb();
                    await scm.refresh({ reason: 'command:absorb' });
                    return;
                }

                case 'jj-view.edit': {
                    let targetRev = '@';
                    if (payload && typeof payload === 'object' && 'ancestor' in payload) {
                        targetRev = (payload as WebGroupPayload).ancestor?.entry.commit_id || '@';
                    }
                    await scm.jj.edit(targetRev);
                    await scm.refresh({ reason: 'command:edit' });
                    return;
                }

                case 'jj-view.showDetails': {
                    let targetRev = '@';
                    if (payload && typeof payload === 'object' && 'ancestor' in payload) {
                        targetRev = (payload as WebGroupPayload).ancestor?.entry.commit_id || '@';
                    }
                    this._context.onShowDetails?.(targetRev);
                    return;
                }

                case 'jj-view.showMultiFileDiff': {
                    let targetRev = '@';
                    if (payload && typeof payload === 'object' && 'ancestor' in payload) {
                        targetRev = (payload as WebGroupPayload).ancestor?.entry.commit_id || '@';
                    }
                    this._context.onShowMultiFileDiff?.(targetRev);
                    return;
                }

                case 'vscode.diff':
                case 'jj-view.openChanges': {
                    if (payload && typeof payload === 'object' && 'resourceUri' in payload) {
                        const item = payload as JjResourceState;
                        this._context.onOpenDiff?.(item.leftUri, item.rightUri, item.diffTitle || 'Diff');
                    }
                    return;
                }

                case 'vscode.open':
                case 'jj-view.openFile': {
                    if (payload && typeof payload === 'object' && 'resourceUri' in payload) {
                        const item = payload as JjResourceState;
                        this._context.onOpenFile?.(item.resourceUri);
                    }
                    return;
                }

                case 'jj-view.openMergeEditor': {
                    if (payload && typeof payload === 'object' && 'resourceUri' in payload) {
                        const item = payload as JjResourceState;
                        this._context.onOpenDiff?.(
                            item.leftUri,
                            item.rightUri,
                            `Merge: ${item.diffTitle || 'Conflict'}`,
                        );
                    }
                    return;
                }

                default:
                    return;
            }
        } catch (err) {
            const error = toError(err);
            this._context.onError?.(error);
        }
    }
}
