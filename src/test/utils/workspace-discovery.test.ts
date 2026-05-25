/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    findJjWorkspaceRoots,
    isJjWorkspaceRoot,
    JJ_WORKSPACE_ROOT_STATE_KEY,
    persistJjWorkspaceRoot,
    type JjWorkspaceDiscoveryContext,
    toJjWorkspaceCandidate,
} from '../../utils/workspace-discovery';
import { TestRepo } from '../test-repo';

function createFakeJjWorkspaceRoot(dir: string): void {
    fs.mkdirSync(path.join(dir, '.jj', 'repo'), { recursive: true });
}

function createMockContext(storedRoot?: string): JjWorkspaceDiscoveryContext {
    const workspaceState = new Map<string, unknown>();
    if (storedRoot) {
        workspaceState.set(JJ_WORKSPACE_ROOT_STATE_KEY, storedRoot);
    }

    return {
        workspaceState: {
            get: <T>(key: string) => workspaceState.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                workspaceState.set(key, value);
            },
        },
    };
}

describe('workspace-discovery (filesystem)', () => {
    let monorepoRoot: string;

    beforeEach(() => {
        monorepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-monorepo-'));
    });

    afterEach(() => {
        fs.rmSync(monorepoRoot, { recursive: true, force: true });
    });

    test('isJjWorkspaceRoot returns true for initialized jj repo', async () => {
        const repo = new TestRepo();
        repo.init();
        try {
            expect(await isJjWorkspaceRoot(repo.path)).toBe(true);
        } finally {
            repo.dispose();
        }
    });

    test('isJjWorkspaceRoot returns false for plain directory', async () => {
        expect(await isJjWorkspaceRoot(monorepoRoot)).toBe(false);
    });

    test('findJjWorkspaceRoots returns workspace root when .jj is at top level', async () => {
        createFakeJjWorkspaceRoot(monorepoRoot);

        const roots = await findJjWorkspaceRoots(monorepoRoot);
        expect(roots).toEqual([monorepoRoot]);
    });

    test('findJjWorkspaceRoots finds repo in subdirectory when none at workspace root', async () => {
        const repoPath = path.join(monorepoRoot, 'packages', 'alpha');
        createFakeJjWorkspaceRoot(repoPath);

        const roots = await findJjWorkspaceRoots(monorepoRoot);
        expect(roots).toEqual([repoPath]);
    });

    test('findJjWorkspaceRoots finds multiple repos and sorts them', async () => {
        const repoAPath = path.join(monorepoRoot, 'packages', 'alpha');
        const repoBPath = path.join(monorepoRoot, 'packages', 'beta');
        createFakeJjWorkspaceRoot(repoAPath);
        createFakeJjWorkspaceRoot(repoBPath);

        const roots = await findJjWorkspaceRoots(monorepoRoot);
        expect(roots).toEqual([repoAPath, repoBPath]);
    });

    test('findJjWorkspaceRoots prefers workspace root over nested repos', async () => {
        createFakeJjWorkspaceRoot(monorepoRoot);
        createFakeJjWorkspaceRoot(path.join(monorepoRoot, 'nested'));

        const roots = await findJjWorkspaceRoots(monorepoRoot);
        expect(roots).toEqual([monorepoRoot]);
    });

    test('toJjWorkspaceCandidate uses relative label', () => {
        const candidate = toJjWorkspaceCandidate('/workspace', '/workspace/packages/foo');
        expect(candidate.label).toBe(`packages${path.sep}foo`);
        expect(candidate.root).toBe('/workspace/packages/foo');
    });
});

describe('resolveJjWorkspaceRoot', () => {
    const { showQuickPick } = vi.hoisted(() => ({
        showQuickPick: vi.fn(),
    }));

    vi.mock('vscode', async () => {
        const { createVscodeMock } = await import('../vscode-mock');
        return createVscodeMock({ window: { showQuickPick } });
    });

    let monorepoRoot: string;

    beforeEach(() => {
        monorepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-monorepo-'));
        showQuickPick.mockReset();
    });

    afterEach(() => {
        fs.rmSync(monorepoRoot, { recursive: true, force: true });
    });

    test('returns the only candidate without showing a picker', async () => {
        const { resolveJjWorkspaceRoot: resolve } = await import('../../utils/workspace-discovery');
        const repoPath = path.join(monorepoRoot, 'packages', 'only');
        createFakeJjWorkspaceRoot(repoPath);

        const resolution = await resolve(monorepoRoot);
        expect(resolution.root).toBe(repoPath);
        expect(resolution.candidateCount).toBe(1);
        expect(showQuickPick).not.toHaveBeenCalled();
    });

    test('shows a picker when multiple repositories are found', async () => {
        const { resolveJjWorkspaceRoot: resolve } = await import('../../utils/workspace-discovery');
        const repoAPath = path.join(monorepoRoot, 'packages', 'alpha');
        const repoBPath = path.join(monorepoRoot, 'packages', 'beta');
        createFakeJjWorkspaceRoot(repoAPath);
        createFakeJjWorkspaceRoot(repoBPath);

        showQuickPick.mockResolvedValue({
            label: `packages${path.sep}beta`,
            description: repoBPath,
            root: repoBPath,
        });

        const resolution = await resolve(monorepoRoot);
        expect(showQuickPick).toHaveBeenCalledOnce();
        expect(resolution.root).toBe(repoBPath);
        expect(resolution.candidateCount).toBe(2);
    });

    test('returns undefined when picker is dismissed', async () => {
        const { resolveJjWorkspaceRoot: resolve } = await import('../../utils/workspace-discovery');
        createFakeJjWorkspaceRoot(path.join(monorepoRoot, 'packages', 'alpha'));
        createFakeJjWorkspaceRoot(path.join(monorepoRoot, 'packages', 'beta'));

        showQuickPick.mockResolvedValue(undefined);

        const resolution = await resolve(monorepoRoot);
        expect(resolution.root).toBeUndefined();
        expect(resolution.candidateCount).toBe(2);
    });

    test('reuses stored workspace root without showing a picker', async () => {
        const { resolveJjWorkspaceRoot: resolve } = await import('../../utils/workspace-discovery');
        const repoAPath = path.join(monorepoRoot, 'packages', 'alpha');
        const repoBPath = path.join(monorepoRoot, 'packages', 'beta');
        createFakeJjWorkspaceRoot(repoAPath);
        createFakeJjWorkspaceRoot(repoBPath);

        const context = createMockContext(repoAPath);
        const resolution = await resolve(monorepoRoot, context);

        expect(resolution.root).toBe(repoAPath);
        expect(resolution.candidateCount).toBe(2);
        expect(showQuickPick).not.toHaveBeenCalled();
    });

    test('persistJjWorkspaceRoot stores the selected root', async () => {
        const context = createMockContext();
        const repoPath = path.join(monorepoRoot, 'packages', 'alpha');

        await persistJjWorkspaceRoot(context, repoPath);
        expect(context.workspaceState.get<string>(JJ_WORKSPACE_ROOT_STATE_KEY)).toBe(repoPath);
    });
});
