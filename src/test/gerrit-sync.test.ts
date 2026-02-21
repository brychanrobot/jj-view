/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { GerritService } from '../gerrit-service';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: (key: string) => {
            if (key === 'gerrit.host') return 'https://test-gerrit.com';
            return undefined;
        }}),
        onDidChangeConfiguration: vi.fn(),
    },
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
        dispose = vi.fn();
    },
    window: { 
        state: { focused: true },
        onDidChangeWindowState: vi.fn(),
    },
}));

describe('Gerrit Sync Verification', () => {
    let repo: TestRepo;
    let jjService: JjService;
    let service: GerritService;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path);
    });

    afterEach(() => {
        service?.dispose();
        repo.dispose();
        vi.clearAllMocks();
    });

    function mockGerritResponse(changeId: string, currentRevision: string, files: Record<string, { status: string; new_sha?: string }>) {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            text: () => {
                const revisions: Record<string, { files: Record<string, { status: string; new_sha?: string }> }> = {};
                revisions[currentRevision] = { files };
                const change = {
                    change_id: changeId,
                    _number: 1,
                    status: 'NEW',
                    submittable: false,
                    unresolved_comment_count: 0,
                    current_revision: currentRevision,
                    revisions,
                };
                return Promise.resolve(`)]}'\n${JSON.stringify([change])}`);
            }
        }) as unknown as typeof fetch;
    }

    test('sets synced=true when local blob hashes match Gerrit', async () => {
        // Create a file in the repo
        repo.writeFile('hello.txt', 'hello world');
        repo.describe('Change-Id: I1111111111111111111111111111111111111111');

        const commitId = repo.getCommitId('@');
        // Get actual blob hash from git
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['hello.txt']);
        const realHash = blobHashes.get('hello.txt')!;

        // Mock Gerrit to return the same hash
        mockGerritResponse('I1111111111111111111111111111111111111111', 'remote-sha', {
            'hello.txt': { status: 'M', new_sha: realHash },
        });

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const result = await service.forceFetchAndCacheStatus(
            commitId, undefined, 'Change-Id: I1111111111111111111111111111111111111111'
        );

        expect(result?.synced).toBe(true);
    });

    test('does not set synced when blob hashes differ', async () => {
        repo.writeFile('hello.txt', 'hello world');
        repo.describe('Change-Id: I2222222222222222222222222222222222222222');

        const commitId = repo.getCommitId('@');

        // Mock Gerrit to return a DIFFERENT hash
        mockGerritResponse('I2222222222222222222222222222222222222222', 'remote-sha', {
            'hello.txt': { status: 'M', new_sha: 'completely-different-hash' },
        });

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const result = await service.forceFetchAndCacheStatus(
            commitId, undefined, 'Change-Id: I2222222222222222222222222222222222222222'
        );

        expect(result?.synced).toBeUndefined();
    });

    test('sets synced when file is deleted on both sides', async () => {
        // Create then delete a file
        repo.writeFile('temp.txt', 'goes away');
        repo.new(undefined, 'Change-Id: I3333333333333333333333333333333333333333');
        repo.deleteFile('temp.txt');

        const commitId = repo.getCommitId('@');

        // Mock Gerrit says file is deleted (no new_sha)
        mockGerritResponse('I3333333333333333333333333333333333333333', 'remote-sha', {
            'temp.txt': { status: 'D' },
        });

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const result = await service.forceFetchAndCacheStatus(
            commitId, undefined, 'Change-Id: I3333333333333333333333333333333333333333'
        );

        expect(result?.synced).toBe(true);
    });

    test('does not set synced when Gerrit says deleted but file exists locally', async () => {
        repo.writeFile('still-here.txt', 'I exist');
        repo.describe('Change-Id: I4444444444444444444444444444444444444444');

        const commitId = repo.getCommitId('@');

        // Mock Gerrit says file was deleted, but it exists locally
        mockGerritResponse('I4444444444444444444444444444444444444444', 'remote-sha', {
            'still-here.txt': { status: 'D' },
        });

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const result = await service.forceFetchAndCacheStatus(
            commitId, undefined, 'Change-Id: I4444444444444444444444444444444444444444'
        );

        expect(result?.synced).toBeUndefined();
    });

    test('skips sync check when currentRevision matches commitId', async () => {
        repo.writeFile('file.txt', 'content');
        repo.describe('Change-Id: I5555555555555555555555555555555555555555');

        const commitId = repo.getCommitId('@');

        // Mock Gerrit to return the SAME commit ID as currentRevision
        mockGerritResponse('I5555555555555555555555555555555555555555', commitId, {
            'file.txt': { status: 'M', new_sha: 'doesnt-matter' },
        });

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const result = await service.forceFetchAndCacheStatus(
            commitId, undefined, 'Change-Id: I5555555555555555555555555555555555555555'
        );

        // When revisions match, synced should not be set (it's already up to date — no need)
        expect(result?.synced).toBeUndefined();
    });
});
