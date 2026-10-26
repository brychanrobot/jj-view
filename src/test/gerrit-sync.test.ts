/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { CodeForgeService } from '../core/code-forge-service';
import { GerritProvider, type GerritRevision } from '../core/gerrit-provider';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import type { CodeForgeChangeInfo, JjLogEntry } from '../core/jj-types';
import { FakeHostEnvironment } from './fake-host-environment';
import { FakeGerritServer } from './helpers/fake-gerrit-server';
import { TestRepo } from './test-repo';
import { createMock, exposePrivate } from './test-utils';

describe('Gerrit Sync Verification', () => {
    let repo: TestRepo;
    let jjService: JjService;
    let registry: CodeForgeRegistry;
    let provider: GerritProvider;
    let service: CodeForgeService;
    let fakeGerritServer: FakeGerritServer;
    let host: FakeHostEnvironment;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        host = new FakeHostEnvironment();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
        fakeGerritServer = new FakeGerritServer();
        await fakeGerritServer.start();

        // Allow host probing to succeed
        vi.spyOn(
            exposePrivate<{ probeGerritHost(h: string): Promise<boolean> }>(GerritProvider.prototype),
            'probeGerritHost',
        ).mockResolvedValue(true);

        host.config.set('gerrit.host', fakeGerritServer.url);
    });

    afterEach(async () => {
        service?.dispose();
        await fakeGerritServer?.stop();
        vi.clearAllMocks();
    });

    function initService(): CodeForgeService {
        registry = new CodeForgeRegistry();
        provider = new GerritProvider(NO_OP_LOGGER, host);
        registry.register({
            id: 'gerrit',
            create: () => provider,
        });
        service = new CodeForgeService(repo.path, jjService, registry, host, NO_OP_LOGGER);
        return service;
    }

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

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);

        expect(result?.contentSynced).toBe(true);
    });

    test('uses pre-fetched changes from request and memoizes content sync outcome', async () => {
        repo.writeFile('hello.txt', 'hello world');
        const desc = 'Change-Id: I1111111111111111111111111111111111111111';
        repo.describe(desc);

        const commitId = repo.getCommitId('@');
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['hello.txt']);
        const realHash = blobHashes.get('hello.txt');
        if (!realHash) {
            throw new Error('Failed to get blob hash for hello.txt');
        }

        mockGerritResponse(
            'I1111111111111111111111111111111111111111',
            'remote-sha',
            {
                'hello.txt': { status: 'M', new_sha: realHash },
            },
            '',
        );

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([
            {
                commitId,
                description: desc,
                parents: [],
                changes: [{ path: 'hello.txt', status: 'modified' }],
            },
        ]);
        const result1 = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);
        expect(result1?.contentSynced).toBe(true);

        // Verify repeated call uses cached contentSynced state
        await service.ensureFreshStatuses([
            {
                commitId,
                description: desc,
                parents: [],
                changes: [{ path: 'hello.txt', status: 'modified' }],
            },
        ]);
        const result2 = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);
        expect(result2?.contentSynced).toBe(true);

        // Verify clearCache clears the content sync cache
        provider.clearCache();
        const resultAfterClear = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);
        expect(resultAfterClear).toBeUndefined();
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

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);

        expect(result?.contentSynced).toBe(false);
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

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);

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

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);

        expect(result?.contentSynced).toBe(false);
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

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);

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

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);

        expect(result?.contentSynced).toBe(true); // Content matches

        // Structural verification now happens in populateCodeForgeInfo
        const commit = createMock<JjLogEntry>({
            commit_id: commitId,
            change_id: 'I6666666666666666666666666666666666666666',
            parents: parents,
        });

        service.populateCodeForgeInfo([commit]);
        expect(commit.codeForgeChange?.parentSynced).toBe(false); // Parents differ
        expect(commit.codeForgeChange?.synced).toBe(false);
    });

    describe('populateCodeForgeInfo', () => {
        beforeEach(async () => {
            service = initService();
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
            vi.spyOn(provider, 'getCachedChangeInfo').mockReturnValue({
                id: 'I1',
                number: 1,
                displayLabel: 'CL/1',
                providerName: 'Gerrit',
                status: 'NEW',
                submittable: false,
                url: '',
                unresolvedComments: 0,
                currentRevision: 'old-sha', // Out of sync
                synced: false,
            });

            service.populateCodeForgeInfo([commit]);

            expect(commit.codeForgeNeedsUpload).toBe(true);
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

            vi.spyOn(provider, 'getCachedChangeInfo').mockImplementation((changeId?: string) => {
                if (changeId === 'I1') {
                    return {
                        id: 'I1',
                        number: 1,
                        displayLabel: 'CL/1',
                        providerName: 'Gerrit',
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
                        id: changeId || '',
                        number: 2,
                        displayLabel: `CL/${changeId}`,
                        providerName: 'Gerrit',
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

            service.populateCodeForgeInfo([c1, c2, c3]);

            expect(c1.codeForgeNeedsUpload).toBe(true); // Direct
            expect(c2.codeForgeNeedsUpload).toBe(true); // Inherited from c1
            expect(c3.codeForgeNeedsUpload).toBe(true); // Inherited transitively from c1
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

            vi.spyOn(provider, 'getCachedChangeInfo').mockReturnValue({
                id: 'I1',
                number: 1,
                displayLabel: 'CL/1',
                providerName: 'Gerrit',
                status: 'NEW',
                submittable: false,
                url: '',
                unresolvedComments: 0,
                currentRevision: 'c1', // In sync
                synced: true,
            });

            service.populateCodeForgeInfo([commit]);

            expect(commit.codeForgeNeedsUpload).toBe(false);
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
                id: 'IA',
                number: 1,
                displayLabel: 'CL/1',
                providerName: 'Gerrit',
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
                id: 'IB',
                number: 2,
                displayLabel: 'CL/2',
                providerName: 'Gerrit',
                status: 'NEW' as const,
                currentRevision: 'b-old-remote',
                contentSynced: true,
                remoteParents: ['a-old-remote'], // Doesn't match aCl.currentRevision
                synced: false,
                url: '',
                unresolvedComments: 0,
                submittable: false,
            };

            vi.spyOn(provider, 'getCachedChangeInfo').mockImplementation((changeId?: string) => {
                if (changeId === 'IA') {
                    return aCl;
                }
                if (changeId === 'IB') {
                    return bCl;
                }
                return undefined;
            });

            // Access private cache to populate it for structural check
            const providerPriv = exposePrivate<{
                resolveCacheKey: (id?: string) => string | undefined;
                cache: Map<string, CodeForgeChangeInfo>;
            }>(provider);
            vi.spyOn(providerPriv, 'resolveCacheKey').mockImplementation((id) => id);
            providerPriv.cache.set('IA', aCl);
            providerPriv.cache.set('IB', bCl);

            service.populateCodeForgeInfo([a, b]);

            expect(b.codeForgeChange?.parentSynced).toBe(false);
            expect(b.codeForgeChange?.synced).toBe(false);
            expect(b.codeForgeNeedsUpload).toBe(true);
        });

        test('divergent commits with same changeId do not cross-contaminate contentSynced state', async () => {
            const changeId = 'I9999999999999999999999999999999999999999';
            mockGerritResponse(
                changeId,
                'rev-commit-1',
                {
                    'file.txt': { status: 'M', new_sha: 'sha-1' },
                },
                'remote desc',
            );

            service = initService();
            await service.awaitReady();

            await service.ensureFreshStatuses([
                { commitId: 'rev-commit-1', changeId, description: 'desc 1', parents: [] },
                { commitId: 'rev-commit-2', changeId, description: 'desc 2', parents: [] },
            ]);

            // Commit 1 matches current_revision
            const commit1Info = provider.getCachedChangeInfo(changeId, 'desc 1', undefined, 'rev-commit-1');
            // Commit 2 is divergent with different commit_id
            const commit2Info = provider.getCachedChangeInfo(changeId, 'desc 2', undefined, 'rev-commit-2');

            expect(commit1Info?.contentSynced).toBe(true);
            expect(commit2Info?.contentSynced).toBe(false);
        });

        test('returns contentSynced: undefined when commitId is omitted to prevent cross-commit leakage', async () => {
            const changeId = 'I9999999999999999999999999999999999999999';
            mockGerritResponse(changeId, 'rev-commit-1', {}, 'desc');

            service = initService();
            await service.awaitReady();

            await service.ensureFreshStatuses([
                { commitId: 'rev-commit-1', changeId, description: 'desc', parents: [] },
            ]);

            const infoWithoutCommitId = provider.getCachedChangeInfo(changeId, 'desc');
            expect(infoWithoutCommitId?.contentSynced).toBeUndefined();
        });

        test('does not mark immutable commits as needing upload or propagate dirty state to clean descendants', () => {
            const immutableParent = createMock<JjLogEntry>({
                commit_id: 'main-sha',
                change_id: 'IMAIN',
                is_immutable: true,
                parents: [],
            });
            const cleanChild = createMock<JjLogEntry>({
                commit_id: 'child-local',
                change_id: 'ICHILD',
                is_immutable: false,
                parents: [{ commit_id: 'main-sha', change_id: 'IMAIN', is_immutable: true }],
            });

            // Suppose IMAIN matches an open cherry-pick CL on another branch in Gerrit with a different revision
            const mainCherryPickCl: CodeForgeChangeInfo = {
                id: 'IMAIN',
                number: 100,
                displayLabel: 'CL/100',
                providerName: 'Gerrit',
                status: 'NEW',
                currentRevision: 'cherry-pick-sha',
                contentSynced: false,
                synced: false,
                url: '',
                unresolvedComments: 0,
                submittable: false,
            };
            const childCl: CodeForgeChangeInfo = {
                id: 'ICHILD',
                number: 101,
                displayLabel: 'CL/101',
                providerName: 'Gerrit',
                status: 'NEW',
                currentRevision: 'child-remote-sha',
                contentSynced: true,
                remoteParents: ['main-sha'],
                url: '',
                unresolvedComments: 0,
                submittable: false,
            };

            vi.spyOn(provider, 'getCachedChangeInfo').mockImplementation((changeId?: string) => {
                if (changeId === 'IMAIN') {
                    return mainCherryPickCl;
                }
                if (changeId === 'ICHILD') {
                    return childCl;
                }
                return undefined;
            });

            service.populateCodeForgeInfo([cleanChild, immutableParent]);

            expect(immutableParent.codeForgeNeedsUpload).toBeUndefined();
            expect(cleanChild.codeForgeChange?.parentSynced).toBe(true);
            expect(cleanChild.codeForgeChange?.synced).toBe(true);
            expect(cleanChild.codeForgeNeedsUpload).toBe(false);
        });

        test('marks multi-commit Gerrit stack as clean when contentSynced is true and Gerrit revisions differ from local commit IDs', () => {
            // Simulates a stack uploaded with `jj gerrit upload`, where Gerrit's patchset SHA
            // differs from the local jj commit_id (due to synthesized Change-Id trailer) and
            // GerritProvider.getCachedChangeInfo returns contentSynced=true with synced=undefined.
            const c1 = createMock<JjLogEntry>({
                commit_id: 'c1-local',
                change_id: 'IC1',
                is_immutable: false,
                parents: [{ commit_id: 'trunk-sha', change_id: 'ITRUNK', is_immutable: true }],
            });
            const c2 = createMock<JjLogEntry>({
                commit_id: 'c2-local',
                change_id: 'IC2',
                is_immutable: false,
                parents: [{ commit_id: 'c1-local', change_id: 'IC1', is_immutable: false }],
            });
            const c3 = createMock<JjLogEntry>({
                commit_id: 'c3-local',
                change_id: 'IC3',
                is_immutable: false,
                parents: [{ commit_id: 'c2-local', change_id: 'IC2', is_immutable: false }],
            });

            vi.spyOn(provider, 'getCachedChangeInfo').mockImplementation((changeId?: string) => {
                if (changeId === 'IC1') {
                    return {
                        id: 'IC1',
                        number: 1,
                        displayLabel: 'CL/1',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        currentRevision: 'c1-gerrit-sha',
                        remoteParents: ['trunk-sha'],
                        contentSynced: true,
                        url: '',
                        unresolvedComments: 0,
                        submittable: false,
                    };
                }
                if (changeId === 'IC2') {
                    return {
                        id: 'IC2',
                        number: 2,
                        displayLabel: 'CL/2',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        currentRevision: 'c2-gerrit-sha',
                        remoteParents: ['c1-gerrit-sha'],
                        contentSynced: true,
                        url: '',
                        unresolvedComments: 0,
                        submittable: false,
                    };
                }
                if (changeId === 'IC3') {
                    return {
                        id: 'IC3',
                        number: 3,
                        displayLabel: 'CL/3',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        currentRevision: 'c3-gerrit-sha',
                        remoteParents: ['c2-gerrit-sha'],
                        contentSynced: true,
                        url: '',
                        unresolvedComments: 0,
                        submittable: false,
                    };
                }
                return undefined;
            });

            // Pass commits in top-down order (matching `jj log` output)
            service.populateCodeForgeInfo([c3, c2, c1]);

            for (const c of [c1, c2, c3]) {
                expect(c.codeForgeChange?.contentSynced).toBe(true);
                expect(c.codeForgeChange?.parentSynced).toBe(true);
                expect(c.codeForgeChange?.synced).toBe(true);
                expect(c.codeForgeNeedsUpload).toBe(false);
            }
        });

        test('propagates parentSynced=false up a Gerrit stack when base commit is rebased onto a new trunk', () => {
            const c1 = createMock<JjLogEntry>({
                commit_id: 'c1-rebased-local',
                change_id: 'IC1',
                is_immutable: false,
                parents: [{ commit_id: 'new-trunk-sha', change_id: 'ITRUNK', is_immutable: true }],
            });
            const c2 = createMock<JjLogEntry>({
                commit_id: 'c2-rebased-local',
                change_id: 'IC2',
                is_immutable: false,
                parents: [{ commit_id: 'c1-rebased-local', change_id: 'IC1', is_immutable: false }],
            });

            vi.spyOn(provider, 'getCachedChangeInfo').mockImplementation((changeId?: string) => {
                if (changeId === 'IC1') {
                    return {
                        id: 'IC1',
                        number: 1,
                        displayLabel: 'CL/1',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        currentRevision: 'c1-old-gerrit-sha',
                        remoteParents: ['old-trunk-sha'],
                        contentSynced: true,
                        url: '',
                        unresolvedComments: 0,
                        submittable: false,
                    };
                }
                if (changeId === 'IC2') {
                    return {
                        id: 'IC2',
                        number: 2,
                        displayLabel: 'CL/2',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        currentRevision: 'c2-old-gerrit-sha',
                        remoteParents: ['c1-old-gerrit-sha'],
                        contentSynced: true,
                        url: '',
                        unresolvedComments: 0,
                        submittable: false,
                    };
                }
                return undefined;
            });

            service.populateCodeForgeInfo([c2, c1]);

            expect(c1.codeForgeChange?.parentSynced).toBe(false);
            expect(c1.codeForgeChange?.synced).toBe(false);
            expect(c1.codeForgeNeedsUpload).toBe(true);

            expect(c2.codeForgeChange?.parentSynced).toBe(false);
            expect(c2.codeForgeChange?.synced).toBe(false);
            expect(c2.codeForgeNeedsUpload).toBe(true);
        });
    });

    test('sets synced=true in non-colocated JJ repository (--no-colocate)', async () => {
        const nonColocatedRepo = new TestRepo();
        try {
            nonColocatedRepo.init({ colocate: false });
            nonColocatedRepo.writeFile('hello.txt', 'non-colocated content');
            const desc = 'Change-Id: I7777777777777777777777777777777777777777';
            nonColocatedRepo.describe(desc);

            const nonColocatedJj = new JjService(nonColocatedRepo.path, NO_OP_LOGGER);
            const commitId = nonColocatedRepo.getCommitId('@');
            const blobHashes = await nonColocatedJj.getGitBlobHashes(commitId, ['hello.txt']);
            const realHash = blobHashes.get('hello.txt');
            expect(realHash).toBeDefined();

            mockGerritResponse(
                'I7777777777777777777777777777777777777777',
                'remote-sha',
                {
                    'hello.txt': { status: 'A', new_sha: realHash },
                },
                '',
            );

            const nonColocatedRegistry = new CodeForgeRegistry();
            const nonColocatedProvider = new GerritProvider(NO_OP_LOGGER, host);
            nonColocatedRegistry.register({ id: 'gerrit', create: () => nonColocatedProvider });
            const nonColocatedService = new CodeForgeService(
                nonColocatedRepo.path,
                nonColocatedJj,
                nonColocatedRegistry,
                host,
                NO_OP_LOGGER,
            );
            try {
                await nonColocatedService.awaitReady();
                await nonColocatedService.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
                const result = nonColocatedProvider.getCachedChangeInfo(undefined, desc, undefined, commitId);
                expect(result?.contentSynced).toBe(true);
            } finally {
                nonColocatedService.dispose();
            }
        } finally {
            await nonColocatedRepo.dispose();
        }
    });

    test('sets contentSynced=false when a file is deleted locally but not on Gerrit', async () => {
        repo.writeFile('keep.txt', 'keep');
        repo.writeFile('delete-me.txt', 'to be deleted');
        const desc = 'Change-Id: I8888888888888888888888888888888888888888';
        repo.new(undefined, desc);
        repo.writeFile('keep.txt', 'keep modified');
        repo.deleteFile('delete-me.txt');

        const commitId = repo.getCommitId('@');
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['keep.txt']);
        const keepHash = blobHashes.get('keep.txt');

        // Gerrit only has keep.txt modified, not delete-me.txt deleted
        mockGerritResponse(
            'I8888888888888888888888888888888888888888',
            'remote-sha',
            {
                'keep.txt': { status: 'M', new_sha: keepHash },
            },
            '',
        );

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);
        expect(result?.contentSynced).toBe(false);
    });

    test('sets contentSynced=true when a file is renamed on both sides and content matches', async () => {
        repo.writeFile('old-name.txt', 'renamed file content line 1\nline 2\nline 3\n');
        const desc = 'Change-Id: Iaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        repo.new(undefined, desc);
        repo.deleteFile('old-name.txt');
        repo.writeFile('new-name.txt', 'renamed file content line 1\nline 2\nline 3\n');

        const commitId = repo.getCommitId('@');
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['new-name.txt']);
        const newHash = blobHashes.get('new-name.txt');

        const revisions: Record<string, GerritRevision> = {
            'remote-sha': {
                files: {
                    'new-name.txt': { status: 'R', old_path: 'old-name.txt', new_sha: newHash },
                },
                commit: { message: `\n\n${desc}` },
            },
        };
        fakeGerritServer.addChange({
            change_id: 'Iaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            _number: 10,
            status: 'NEW',
            current_revision: 'remote-sha',
            revisions,
        });

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);
        expect(result?.contentSynced).toBe(true);
    });

    test('sets contentSynced=false when local description is empty but Gerrit has a non-empty description', async () => {
        repo.writeFile('hello.txt', 'hello world');
        const commitId = repo.getCommitId('@');
        const changeId = 'Ibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['hello.txt']);
        const realHash = blobHashes.get('hello.txt');

        mockGerritResponse(
            changeId,
            'remote-sha',
            {
                'hello.txt': { status: 'A', new_sha: realHash },
            },
            'Non-empty remote description',
        );

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, changeId, description: '', parents: [] }]);
        const result = provider.getCachedChangeInfo(changeId, '', undefined, commitId);
        expect(result?.contentSynced).toBe(false);
    });

    test('resolves and strips Link: <host>/id/I<40-hex> trailers during sync check', async () => {
        repo.writeFile('hello.txt', 'hello world');
        const changeId = 'Icccccccccccccccccccccccccccccccccccccccc';
        const desc = `My feature\n\nLink: ${fakeGerritServer.url}/id/${changeId}`;
        repo.describe(desc);

        const commitId = repo.getCommitId('@');
        const blobHashes = await jjService.getGitBlobHashes(commitId, ['hello.txt']);
        const realHash = blobHashes.get('hello.txt');

        mockGerritResponse(
            changeId,
            'remote-sha',
            {
                'hello.txt': { status: 'A', new_sha: realHash },
            },
            'My feature',
        );

        service = initService();
        await service.awaitReady();

        await service.ensureFreshStatuses([{ commitId, description: desc, parents: [] }]);
        const result = provider.getCachedChangeInfo(undefined, desc, undefined, commitId);
        expect(result?.contentSynced).toBe(true);
    });
});
