/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const JJ_WORKSPACE_ROOT_STATE_KEY = 'jjWorkspaceRoot';

const SKIP_DIR_NAMES = new Set([
    '.git',
    '.jj',
    '.hg',
    '.svn',
    '.vscode',
    '.vscode-test',
    'node_modules',
    'dist',
    'out',
    'target',
    'build',
]);

export interface JjWorkspaceCandidate {
    label: string;
    description: string;
    root: string;
}

export interface JjWorkspaceResolution {
    root?: string;
    candidateCount: number;
}

export interface JjWorkspaceDiscoveryContext {
    workspaceState: {
        get<T>(key: string): T | undefined;
        update(key: string, value: unknown): Thenable<void>;
    };
}

/** Returns true when `dir` contains a `.jj/repo` store (directory or pointer file). */
export async function isJjWorkspaceRoot(dir: string): Promise<boolean> {
    try {
        const jjPath = path.join(dir, '.jj');
        const jjStats = await fs.lstat(jjPath);
        if (!jjStats.isDirectory()) {
            return false;
        }
        await fs.lstat(path.join(jjPath, 'repo'));
        return true;
    } catch {
        return false;
    }
}

/**
 * Finds jj workspace roots under a VS Code workspace folder.
 * When the workspace root itself is a jj repo, returns only that path.
 */
export async function findJjWorkspaceRoots(vscodeWorkspaceRoot: string): Promise<string[]> {
    if (await isJjWorkspaceRoot(vscodeWorkspaceRoot)) {
        return [vscodeWorkspaceRoot];
    }

    const found: string[] = [];
    await scanForJjWorkspaces(vscodeWorkspaceRoot, found);
    return found.sort((a, b) => a.localeCompare(b));
}

async function scanForJjWorkspaces(dir: string, found: string[]): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) {
            continue;
        }

        const childPath = path.join(dir, entry.name);
        if (await isJjWorkspaceRoot(childPath)) {
            found.push(childPath);
            continue;
        }

        await scanForJjWorkspaces(childPath, found);
    }
}

export function toJjWorkspaceCandidate(vscodeWorkspaceRoot: string, jjWorkspaceRoot: string): JjWorkspaceCandidate {
    const relative = path.relative(vscodeWorkspaceRoot, jjWorkspaceRoot);
    return {
        label: relative === '' ? '.' : relative,
        description: jjWorkspaceRoot,
        root: jjWorkspaceRoot,
    };
}

export async function persistJjWorkspaceRoot(
    context: JjWorkspaceDiscoveryContext,
    jjWorkspaceRoot: string,
): Promise<void> {
    await context.workspaceState.update(JJ_WORKSPACE_ROOT_STATE_KEY, jjWorkspaceRoot);
}

/**
 * Shows a quick pick to choose among discovered jj workspace roots.
 */
export async function pickJjWorkspaceRoot(
    vscodeWorkspaceRoot: string,
    options: { currentRoot?: string; candidates?: string[] } = {},
): Promise<string | undefined> {
    const candidates = options.candidates ?? (await findJjWorkspaceRoots(vscodeWorkspaceRoot));
    if (candidates.length === 0) {
        return undefined;
    }
    if (candidates.length === 1) {
        return candidates[0];
    }

    const items = candidates.map((root) => {
        const item = toJjWorkspaceCandidate(vscodeWorkspaceRoot, root);
        if (root === options.currentRoot) {
            return {
                ...item,
                description: `${item.description} (current)`,
            };
        }
        return item;
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Jujutsu repository to use with JJ View',
        title: 'Multiple JJ repositories found',
    });

    return selected?.root;
}

/**
 * Resolves the jj workspace root for a VS Code workspace folder.
 * Reuses a stored choice when valid; shows a quick pick when multiple repositories are found.
 */
export async function resolveJjWorkspaceRoot(
    vscodeWorkspaceRoot: string,
    context?: JjWorkspaceDiscoveryContext,
): Promise<JjWorkspaceResolution> {
    const candidates = await findJjWorkspaceRoots(vscodeWorkspaceRoot);
    if (candidates.length === 0) {
        return { candidateCount: 0 };
    }

    const storedRoot = context?.workspaceState.get<string>(JJ_WORKSPACE_ROOT_STATE_KEY);
    if (storedRoot && candidates.includes(storedRoot)) {
        return { root: storedRoot, candidateCount: candidates.length };
    }

    if (candidates.length === 1) {
        const root = candidates[0];
        if (context) {
            await persistJjWorkspaceRoot(context, root);
        }
        return { root, candidateCount: 1 };
    }

    const picked = await pickJjWorkspaceRoot(vscodeWorkspaceRoot, { candidates });
    if (picked && context) {
        await persistJjWorkspaceRoot(context, picked);
    }

    return { root: picked, candidateCount: candidates.length };
}
