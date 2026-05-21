/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type GerritRevision, GerritService } from '../gerrit-service';
import { JjService } from '../jj-service';
import type { GerritClInfo, JjLogEntry } from '../jj-types';
import { FakeGerritServer } from './helpers/fake-gerrit-server';
import { TestRepo } from './test-repo';
import { createMock, exposePrivate } from './test-utils';

// Mock VS Code configuration
const mockConfig = {
    get: vi.fn(),
};

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => mockConfig,
        onDidChangeConfiguration: vi.fn(),
    },
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
        dispose = vi.fn();
    },
    window: {
        state: { focused: true },
        onDidChangeWindowState: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    Uri: {
        file: (path: string) => ({ fsPath: path, scheme: 'file' }),
    },
}));

describe('Gerrit Sync Verification', () => {
    let repo: TestRepo;
    let jjService: JjService;
    let service: GerritService;
    let fakeGerritServer: FakeGerritServer;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path);
        fakeGerritServer = new FakeGerritServer();
        await fakeGerritServer.start();

        // Allow host probing to succeed
        vi.spyOn(
            exposePrivate<{ probeGerritHost(h: string): Promise<boolean> }>(GerritService.prototype),
            'probeGerritHost',
        ).mockResolvedValue(true);

        mockConfig.get.mockImplementation((key: string) => {
            if (key === 'gerrit.host') {
                return fakeGerritServer.url;
            }
            return undefined;
        });
    });

    afterEach(async () => {
        service?.dispose();
        await fakeGerritServer?.stop();
        repo.dispose();
        vi.clearAllMocks();
    });

    function mockGerritResponse(
        changeId: string,
        currentRevision: string,
        files: Record<string, { status: string; new_sha?: string }>,
        description = 'Test Description',
    ) {
        const revisions: Record<string, GerritRevision> = {};
        revisions[currentRevision] = {
            files,
            commit: { message: `${description}\n\nChange-Id: ${changeId}` },
        };
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 1,
            status: 'NEW',
            current_revision: currentRevision,
            revisions,
        });
    }

    test('sets synced=true when local blob hashes match Gerrit', async () => {
        // Create a file in the repo
        repo.writeFile('hello.txt', 'hello world');
        const desc = 'Change-Id: I1111111111111111111111111111111111111111';
        repo.describe(desc);

        const commitId = repo.getCommitId('@');
        // Get actual blob hash from git
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['hello.txt']);
        const realHash = blobHashes.get('hello.txt');
        if (!realHash) {
            throw new Error('Failed to get blob hash for hello.txt');
        }

        // Mock Gerrit to return the same hash
        // Use empty description on remote too since local is just Change-Id
        mockGerritResponse(
            'I1111111111111111111111111111111111111111',
            'remote-sha',
            {
                'hello.txt': { status: 'M', new_sha: realHash },
            },
            '',
        );

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        expect(result?.contentSynced).toBe(true);
    });

    test('does not set synced when blob hashes differ', async () => {
        repo.writeFile('hello.txt', 'hello world');
        const desc = 'Change-Id: I2222222222222222222222222222222222222222';
        repo.describe(desc);

        const commitId = repo.getCommitId('@');

        // Mock Gerrit to return a DIFFERENT hash
        mockGerritResponse(
            'I2222222222222222222222222222222222222222',
            'remote-sha',
            {
                'hello.txt': { status: 'M', new_sha: 'completely-different-hash' },
            },
            '',
        );

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        expect(result?.contentSynced).toBeUndefined();
    });

    test('sets synced when file is deleted on both sides', async () => {
        // Create then delete a file
        repo.writeFile('temp.txt', 'goes away');
        const desc = 'Change-Id: I3333333333333333333333333333333333333333';
        repo.new(undefined, desc);
        repo.deleteFile('temp.txt');

        const commitId = repo.getCommitId('@');

        // Mock Gerrit says file is deleted (no new_sha)
        mockGerritResponse(
            'I3333333333333333333333333333333333333333',
            'remote-sha',
            {
                'temp.txt': { status: 'D' },
            },
            '',
        );

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        expect(result?.contentSynced).toBe(true);
    });

    test('does not set synced when Gerrit says deleted but file exists locally', async () => {
        repo.writeFile('still-here.txt', 'I exist');
        const desc = 'Change-Id: I4444444444444444444444444444444444444444';
        repo.describe(desc);

        const commitId = repo.getCommitId('@');

        // Mock Gerrit says file was deleted, but it exists locally
        mockGerritResponse(
            'I4444444444444444444444444444444444444444',
            'remote-sha',
            {
                'still-here.txt': { status: 'D' },
            },
            '',
        );

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        expect(result?.contentSynced).toBeUndefined();
    });

    test('skips sync check when currentRevision matches commitId', async () => {
        repo.writeFile('file.txt', 'content');
        const desc = 'Change-Id: I5555555555555555555555555555555555555555';
        repo.describe(desc);

        const commitId = repo.getCommitId('@');

        // Mock Gerrit to return the SAME commit ID as currentRevision
        mockGerritResponse(
            'I5555555555555555555555555555555555555555',
            commitId,
            {
                'file.txt': { status: 'M', new_sha: 'doesnt-matter' },
            },
            '',
        );

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        // When revisions match, we now set synced=true explicitly as it's definitely synced
        expect(result?.contentSynced).toBe(true);
    });

    test('sets parentSynced=false when parents differ from Gerrit', async () => {
        repo.writeFile('hello.txt', 'hello world');
        const desc = 'Change-Id: I6666666666666666666666666666666666666666';
        repo.describe(desc);

        const commitId = repo.getCommitId('@');
        const parents = (await jjService.getLog({ revision: commitId }))[0].parents;
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['hello.txt']);
        const realHash = blobHashes.get('hello.txt');

        fakeGerritServer.addChange({
            change_id: 'I6666666666666666666666666666666666666666',
            _number: 6,
            status: 'NEW',
            current_revision: 'remote-sha',
            revisions: {
                'remote-sha': {
                    commit: {
                        message: `\n\nChange-Id: I6666666666666666666666666666666666666666`,
                        parents: [{ commit: 'completely-different-parent' }],
                    },
                    files: { 'hello.txt': { status: 'M', new_sha: realHash } },
                },
            } as Record<string, GerritRevision>,
        });

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        expect(result?.contentSynced).toBe(true); // Content matches

        // Structural verification now happens in populateGerritInfo
        const commit = createMock<JjLogEntry>({
            commit_id: commitId,
            change_id: 'I6666666666666666666666666666666666666666',
            parents: parents,
        });

        service.populateGerritInfo([commit]);
        expect(commit.gerritCl?.parentSynced).toBe(false); // Parents differ
        expect(commit.gerritCl?.synced).toBe(false);
    });

    describe('populateGerritInfo', () => {
        beforeEach(async () => {
            service = new GerritService(repo.path, jjService);
            await service.awaitReady();
        });

        test('computes gerritNeedsUpload for a single out-of-sync commit', () => {
            const commit = createMock<JjLogEntry>({
                commit_id: 'c1',
                change_id: 'I1',
                description: 'desc',
                author: { name: 'A', email: 'a@e.com', timestamp: '' },
                committer: { name: 'A', email: 'a@e.com', timestamp: '' },
                parents: [],
            });

            // Mock cache
            vi.spyOn(service, 'getCachedClStatus').mockReturnValue({
                changeId: 'I1',
                changeNumber: 1,
                status: 'NEW',
                submittable: false,
                url: '',
                unresolvedComments: 0,
                currentRevision: 'old-sha', // Out of sync
                synced: false,
            });

            service.populateGerritInfo([commit]);

            expect(commit.gerritNeedsUpload).toBe(true);
        });

        test('computes gerritNeedsUpload recursively for descendants of out-of-sync commits', () => {
            const c1 = createMock<JjLogEntry>({
                commit_id: 'c1',
                change_id: 'I1',
                description: 'desc1',
                author: { name: 'A', email: 'a@e.com', timestamp: '' },
                committer: { name: 'A', email: 'a@e.com', timestamp: '' },
                parents: [],
            });
            const c2 = createMock<JjLogEntry>({
                commit_id: 'c2',
                change_id: 'I2',
                description: 'desc2',
                author: { name: 'A', email: 'a@e.com', timestamp: '' },
                committer: { name: 'A', email: 'a@e.com', timestamp: '' },
                parents: [{ commit_id: 'c1', change_id: 'I1', is_immutable: false }], // Child of c1
            });
            const c3 = createMock<JjLogEntry>({
                commit_id: 'c3',
                change_id: 'I3',
                description: 'desc3',
                author: { name: 'A', email: 'a@e.com', timestamp: '' },
                committer: { name: 'A', email: 'a@e.com', timestamp: '' },
                parents: [{ commit_id: 'c2', change_id: 'I2', is_immutable: false }], // Child of c2
            });

            vi.spyOn(service, 'getCachedClStatus').mockImplementation((changeId) => {
                if (changeId === 'I1') {
                    return {
                        changeId: 'I1',
                        changeNumber: 1,
                        status: 'NEW',
                        submittable: false,
                        url: '',
                        unresolvedComments: 0,
                        currentRevision: 'old-sha', // Out of sync
                        synced: false,
                    };
                }
                if (changeId === 'I2' || changeId === 'I3') {
                    return {
                        changeId,
                        changeNumber: 2,
                        status: 'NEW',
                        submittable: false,
                        url: '',
                        unresolvedComments: 0,
                        currentRevision: changeId === 'I2' ? 'c2' : 'c3', // In sync directly
                        synced: true,
                    };
                }
                return undefined;
            });

            service.populateGerritInfo([c1, c2, c3]);

            expect(c1.gerritNeedsUpload).toBe(true); // Direct
            expect(c2.gerritNeedsUpload).toBe(true); // Inherited from c1
            expect(c3.gerritNeedsUpload).toBe(true); // Inherited transitively from c1
        });

        test('does not set gerritNeedsUpload if all are in sync', () => {
            const commit = createMock<JjLogEntry>({
                commit_id: 'c1',
                change_id: 'I1',
                description: 'desc',
                author: { name: 'A', email: 'a@e.com', timestamp: '' },
                committer: { name: 'A', email: 'a@e.com', timestamp: '' },
                parents: [],
            });

            vi.spyOn(service, 'getCachedClStatus').mockReturnValue({
                changeId: 'I1',
                changeNumber: 1,
                status: 'NEW',
                submittable: false,
                url: '',
                unresolvedComments: 0,
                currentRevision: 'c1', // In sync
                synced: true,
            });

            service.populateGerritInfo([commit]);

            expect(commit.gerritNeedsUpload).toBe(false);
        });

        test('detects structural mismatch (rebase hole) in a stack', () => {
            // Setup a stack A -> B
            const a = createMock<JjLogEntry>({
                commit_id: 'a-local',
                change_id: 'IA',
                parents: [],
            });
            const b = createMock<JjLogEntry>({
                commit_id: 'b-local',
                change_id: 'IB',
                parents: [{ commit_id: 'a-local', change_id: 'IA', is_immutable: false }],
            });

            // Mock the cache contents
            // Parent A is in sync on Gerrit
            const aCl = {
                changeId: 'IA',
                changeNumber: 1,
                status: 'NEW' as const,
                currentRevision: 'a-local',
                contentSynced: true,
                parentSynced: true,
                synced: true,
                url: '',
                unresolvedComments: 0,
                submittable: false,
            };
            // Child B has matching content, BUT its parent in Gerrit is an OLD revision of A
            const bCl = {
                changeId: 'IB',
                changeNumber: 2,
                status: 'NEW' as const,
                currentRevision: 'b-old-remote',
                contentSynced: true,
                gerritParents: ['a-old-remote'], // Doesn't match aCl.currentRevision
                synced: false,
                url: '',
                unresolvedComments: 0,
                submittable: false,
            };

            vi.spyOn(service, 'getCachedClStatus').mockImplementation((changeId) => {
                if (changeId === 'IA') {
                    return aCl;
                }
                if (changeId === 'IB') {
                    return bCl;
                }
                return undefined;
            });

            // Access private cache to populate it for structural check
            const servicePriv = exposePrivate<{
                resolveCacheKey: (id: string) => string;
                cache: Map<string, GerritClInfo>;
            }>(service);
            vi.spyOn(servicePriv, 'resolveCacheKey').mockImplementation((id) => id);
            servicePriv.cache.set('IA', aCl);
            servicePriv.cache.set('IB', bCl);

            service.populateGerritInfo([a, b]);

            expect(b.gerritCl?.parentSynced).toBe(false);
            expect(b.gerritCl?.synced).toBe(false);
            expect(b.gerritNeedsUpload).toBe(true);
        });
    });
});
