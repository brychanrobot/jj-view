/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NodeHostSystem } from '../core/host/node-host-system';
import { clearGitRootCache, getGitConfig, resolveGitRoot } from '../utils/git-repo-utils';
import { TestRepo } from './test-repo';

describe('git-repo-utils', () => {
    const system = new NodeHostSystem();
    let tempDir: string;
    let repo: TestRepo | undefined;

    beforeEach(async () => {
        clearGitRootCache();
        repo = undefined;
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-view-git-repo-utils-'));
    });

    afterEach(async () => {
        clearGitRootCache();
        if (repo) {
            await repo.dispose();
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('resolveGitRoot resolves the git directory of a jj repo and caches it', async () => {
        repo = new TestRepo();
        repo.init();

        const gitRoot1 = await resolveGitRoot(system, repo.path);
        expect(gitRoot1).not.toBeNull();
        expect(gitRoot1).toBeSameFsPath(path.join(repo.path, '.git'));

        const gitRoot2 = await resolveGitRoot(system, repo.path);
        expect(gitRoot2).toBe(gitRoot1);
    });

    test('resolveGitRoot returns null outside a jj repo', async () => {
        expect(await resolveGitRoot(system, tempDir)).toBeNull();
        expect(await resolveGitRoot(system, tempDir)).toBeNull();
    });

    test('getGitConfig reads values and returns null for unset keys', async () => {
        repo = new TestRepo();
        repo.init();
        const gitDir = path.join(repo.path, '.git');
        cp.execFileSync('git', ['--git-dir', gitDir, 'config', 'gerrit.host', 'https://gerrit.example.com']);

        expect(await getGitConfig(system, gitDir, 'gerrit.host')).toBe('https://gerrit.example.com');
        expect(await getGitConfig(system, gitDir, 'gerrit.missing')).toBeNull();
        expect(await getGitConfig(system, null, 'gerrit.host')).toBeNull();
    });
});
