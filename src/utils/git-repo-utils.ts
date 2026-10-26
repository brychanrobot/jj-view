/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { HostSystem } from '../core/host/host-system';
import { AsyncCache } from './async-cache';

const gitRootCache = new AsyncCache<string, string | null>({
    maxEntries: 100,
});

/**
 * Clears the in-memory cache of resolved git roots.
 */
export function clearGitRootCache(): void {
    void gitRootCache.clear();
}

/**
 * Resolves the backing git directory of a jj repository using `jj git root`.
 * Runs through the host so it works identically in VS Code and the web UI.
 */
export async function resolveGitRoot(system: HostSystem, repoRoot: string, binaryPath = 'jj'): Promise<string | null> {
    const cacheKey = `${binaryPath}:${repoRoot}`;
    return gitRootCache.getOrFetch(cacheKey, async () => {
        try {
            const { stdout } = await system.process.execFile(binaryPath, ['git', 'root'], {
                cwd: repoRoot,
                timeout: 10000,
            });
            const trimmed = stdout.trim();
            return trimmed.length > 0 ? trimmed : null;
        } catch {
            return null;
        }
    });
}

/**
 * Reads a single value from the git configuration of `gitDir`, or null when
 * the key is unset or git fails.
 */
export async function getGitConfig(system: HostSystem, gitDir: string | null, key: string): Promise<string | null> {
    if (!gitDir) {
        return null;
    }
    try {
        const { stdout } = await system.process.execFile('git', [`--git-dir=${gitDir}`, 'config', '--get', key], {
            timeout: 10000,
        });
        const trimmed = stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
    } catch {
        return null;
    }
}
