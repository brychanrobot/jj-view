/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { extractUriFromArgs } from '../commands/command-utils';
import type { JjRepository } from '../jj-repository';
import type { JjRepositoryManager } from '../jj-repository-manager';
import { JjService } from '../jj-service';
import { getUriParams, Uri } from '../uri-utils';
import { getErrorMessage, toError } from '../utils/error-utils';
import type { LoggerChannel } from '../utils/output-channel';
import type { HostEnvironment, HostUi } from './host-environment';

export interface PromptRevisionOptions {
    placeHolder?: string;
    revisionQuery?: string;
    emptyPrompt?: string;
}

/**
 * Prompts the user to select a revision from the repository, falling back to an input box
 * if no revisions match or if an error occurs.
 */
export async function promptForRevision(
    ui: HostUi,
    jj: JjService,
    options?: PromptRevisionOptions,
): Promise<string | undefined> {
    const placeHolder = options?.placeHolder ?? 'Select target revision';
    const revisionQuery = options?.revisionQuery ?? 'all()';
    const emptyPrompt = options?.emptyPrompt ?? 'Enter revision';
    const limit = 200;

    try {
        const ancestors = await jj.getLog({
            revision: revisionQuery,
            limit,
            omitChanges: true,
        });

        const items = ancestors.map((entry) => {
            const shortId = entry.change_id_shortest || entry.change_id.substring(0, 8);
            const desc = entry.description?.trim() || '(no description)';
            const shortDesc = desc.split('\n')[0].substring(0, 50);

            let bookmarkStr = '';
            if (entry.bookmarks && entry.bookmarks.length > 0) {
                bookmarkStr = ` (${entry.bookmarks.map((b) => b.name).join(', ')})`;
            }

            return {
                label: `${shortId}${bookmarkStr}`,
                description: shortDesc,
                detail: entry.change_id,
                value: entry.change_id,
            };
        });

        if (items.length === 0) {
            return await ui.showInputBox({
                prompt: `${emptyPrompt} (no ancestors found)`,
                placeHolder: 'e.g. main, @-',
            });
        }

        const selected = await ui.showQuickPick(items, {
            placeHolder,
            matchOnDescription: true,
            matchOnDetail: true,
            acceptCustomValue: true,
        });

        if (!selected) {
            return undefined;
        }

        const item = selected as { customValue?: string; detail?: string; value?: unknown; label?: string };
        return item.customValue ?? item.detail ?? (item.value !== undefined ? String(item.value) : item.label);
    } catch {
        return await ui.showInputBox({
            prompt: emptyPrompt,
            placeHolder: 'e.g. main, @-',
        });
    }
}

/**
 * Prompts the user to select an existing item or enter a new name (e.g. for bookmark creation).
 */
export async function promptSelectOrCreate(
    ui: HostUi,
    options: {
        placeHolder?: string;
        items: { label: string; description?: string }[];
    },
): Promise<string | undefined> {
    const selected = await ui.showQuickPick(options.items, {
        placeHolder: options.placeHolder,
        matchOnDescription: true,
        acceptCustomValue: true,
    });
    const item = selected as { customValue?: string; value?: unknown; label?: string } | undefined;
    return item?.customValue ?? (item?.value !== undefined ? String(item.value) : item?.label);
}

/**
 * Displays a formatted JJ error message to the user, checks for Git index lock errors,
 * provides recovery actions ('Delete Lock File', 'Show Log'), and logs error diagnostics.
 */
export async function showJjError(
    ui: HostUi,
    error: unknown,
    prefix: string,
    jj?: JjService,
    log?: LoggerChannel,
    extraActions: string[] = [],
): Promise<string | undefined> {
    const message = getErrorMessage(error);
    let fullMessage = `${prefix}: ${message}`;

    const isLockError = JjService.isIndexLockError(error);
    const DELETE_LOCK = 'Delete Lock File';
    let lockPath: string | undefined;
    let actions = [...extraActions];

    if (isLockError && jj) {
        try {
            const repoRoot = await jj.getRepoRoot();
            lockPath = path.join(repoRoot, '.git', 'index.lock');
            fullMessage = `${prefix}: Git index is locked. Another process may have crashed. Delete .git/index.lock to resolve.`;
            if (!actions.includes(DELETE_LOCK)) {
                actions = [DELETE_LOCK, ...actions];
            }
        } catch {
            // Ignore if we can't figure out the repo root
        }
    }

    if (!process.env.VITEST) {
        console.error(fullMessage, error);
    }
    log?.error(fullMessage, error !== undefined ? toError(error) : undefined);

    const SHOW_LOG = 'Show Log';
    const selection = await ui.showErrorMessage(fullMessage, SHOW_LOG, ...actions);

    if (selection === SHOW_LOG) {
        log?.show?.();
    } else if (selection === DELETE_LOCK && lockPath) {
        try {
            await fs.unlink(lockPath);
            log?.info(`Deleted lock file at ${lockPath}`);
        } catch (e) {
            const errStr = getErrorMessage(e);
            log?.error(`Failed to delete lock file: ${errStr}`, toError(e));
            await ui.showErrorMessage(`Failed to delete lock file: ${errStr}`);
        }
    }
    return selection;
}

/**
 * Runs an asynchronous task with a progress notification only if the task takes longer
 * than delayMs (default: 100ms), preventing UI flashes for fast operations.
 */
export async function withDelayedProgress<T>(
    ui: HostUi,
    title: string,
    task: () => Promise<T>,
    delayMs: number = 100,
): Promise<T> {
    let taskCompleted = false;
    let progressComplete: (() => void) | undefined;

    const timer = setTimeout(() => {
        if (taskCompleted) {
            return;
        }
        void ui
            .withProgress(
                title,
                () =>
                    new Promise<void>((resolve) => {
                        progressComplete = resolve;
                        if (taskCompleted) {
                            resolve();
                        }
                    }),
            )
            .then(undefined, () => {});
    }, delayMs);

    try {
        return await task();
    } finally {
        taskCompleted = true;
        clearTimeout(timer);
        if (progressComplete) {
            progressComplete();
        }
    }
}

export interface ResolveRepositoryOptions {
    args?: unknown[];
    host?: HostEnvironment;
    activeUri?: Uri;
}

/**
 * Resolves a repository from invocation arguments, host active document URI, or falls back to
 * the focused repository in the repository manager.
 */
export function resolveRepository(
    repositoryManager: JjRepositoryManager,
    options?: ResolveRepositoryOptions,
): JjRepository | undefined {
    let uri: Uri | undefined;

    // 1. Check if args contain URI, SCM object with rootUri, or resource group
    if (options?.args && options.args.length > 0) {
        const firstArg = options.args[0];
        if (firstArg && typeof firstArg === 'object') {
            if ('rootUri' in firstArg) {
                const scmObj = firstArg as { rootUri: unknown };
                if (Uri.isUri(scmObj.rootUri)) {
                    uri = scmObj.rootUri;
                }
            } else if ('resourceUri' in firstArg) {
                const stateObj = firstArg as { resourceUri: unknown };
                if (Uri.isUri(stateObj.resourceUri)) {
                    uri = stateObj.resourceUri;
                }
            } else if ('resourceStates' in firstArg) {
                const groupObj = firstArg as { resourceStates: unknown };
                if (Array.isArray(groupObj.resourceStates) && groupObj.resourceStates.length > 0) {
                    const firstState = groupObj.resourceStates[0] as { resourceUri?: unknown };
                    if (firstState && Uri.isUri(firstState.resourceUri)) {
                        uri = firstState.resourceUri;
                    }
                }
            }
        }
        if (!uri) {
            uri = extractUriFromArgs(options.args);
            if (uri) {
                repositoryManager.outputChannel.info(
                    `[resolveRepository] Extracted candidate URI from arguments: ${uri.toString()}`,
                );
            }
        }
    }

    // 2. Check active editor URI / document URI from options or host
    const candidateActiveUri = options?.activeUri ?? options?.host?.documents.getActiveDocumentUri?.();
    if (!uri && candidateActiveUri) {
        if (candidateActiveUri.scheme === 'jj-commit') {
            const query = getUriParams(candidateActiveUri);
            const repoRoot = query.get('repoRoot');
            if (repoRoot) {
                uri = Uri.file(decodeURIComponent(repoRoot));
                repositoryManager.outputChannel.info(
                    `[resolveRepository] Resolved candidate URI from active jj-commit editor repoRoot: ${uri.toString()}`,
                );
            }
        } else {
            uri = candidateActiveUri;
            repositoryManager.outputChannel.info(
                `[resolveRepository] Resolved candidate URI from active text editor: ${candidateActiveUri.toString()}`,
            );
        }
    }

    // 3. Resolve repository matching candidate URI or fall back to focused repository
    let repo = uri ? repositoryManager.getRepositoryForUri(uri) : undefined;
    if (repo) {
        repositoryManager.outputChannel.info(
            `[resolveRepository] Successfully resolved repository for URI: ${repo.rootUri.fsPath}`,
        );
    } else {
        if (uri) {
            repositoryManager.outputChannel.info(
                `[resolveRepository] No repository matched candidate URI: ${uri.toString()}`,
            );
        }
        repo = repositoryManager.focusedRepository;
        if (repo) {
            repositoryManager.outputChannel.info(
                `[resolveRepository] Fallback to focused repository: ${repo.rootUri.fsPath}`,
            );
        } else {
            repositoryManager.outputChannel.info(`[resolveRepository] No repository resolved.`);
        }
    }

    return repo;
}
