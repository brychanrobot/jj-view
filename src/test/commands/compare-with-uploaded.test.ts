/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeForgeProvider } from '../../core/code-forge-provider';
import type { CodeForgeService } from '../../core/code-forge-service';
import { compareWithUploadedCommand, computeUnuploadedComparison } from '../../core/commands/compare-with-uploaded';
import { type ProcessExecOptions, ProcessExitError, type ProcessResult } from '../../core/host/host-system';
import { NodeHostProcess, NodeHostSystem } from '../../core/host/node-host-system';
import type { JjRepository } from '../../core/jj-repository';
import type { CodeForgeChangeInfo } from '../../core/jj-schemas';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { decodeJjViewQuery } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('compareWithUploaded', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;
    let currentCodeForgeChange: CodeForgeChangeInfo | undefined;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        currentCodeForgeChange = undefined;

        const codeForge = createMock<CodeForgeService>({
            populateCodeForgeInfo: (commits) => {
                if (currentCodeForgeChange) {
                    for (const c of commits) {
                        c.codeForgeChange = { ...currentCodeForgeChange };
                        c.codeForgeNeedsUpload = !currentCodeForgeChange.synced;
                    }
                }
            },
        });

        mockJjRepo = createMock<JjRepository>({ jj, codeForge });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(async () => {
        await repo.dispose();
        vi.clearAllMocks();
    });

    it('throws when the revision has no associated Code Forge change', async () => {
        repo.writeFile('test.txt', 'hello');
        repo.describe('test: simple commit');
        const changeId = repo.getChangeId('@');

        await expect(computeUnuploadedComparison(mockJjRepo, changeId)).rejects.toThrow(
            /not linked to an uploaded change/,
        );
    });

    it('detects description change and prepends synthetic COMMIT_MSG', async () => {
        repo.writeFile('test.txt', 'hello world');
        const localDesc = 'test: local updated description\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678';
        repo.describe(localDesc);
        const commitId = repo.getCommitId('@');
        const changeId = repo.getChangeId('@');

        const hashes = await jj.getGitBlobHashes(commitId, ['test.txt']);
        const blobSha = hashes.get('test.txt');

        currentCodeForgeChange = {
            id: 'I1234567890abcdef1234567890abcdef12345678',
            number: 12345,
            displayLabel: 'CL/12345',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/12345',
            unresolvedComments: 0,
            currentRevision: 'remote-rev-sha',
            remoteDescription:
                'test: remote uploaded description\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678',
            files: {
                'test.txt': { newSha: blobSha, status: 'M' },
            },
            synced: false,
            contentSynced: false,
        };

        const result = await computeUnuploadedComparison(mockJjRepo, changeId);
        expect(result.descriptionModified).toBe(true);
        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].label).toBe('COMMIT_MSG');

        const leftQuery = decodeJjViewQuery(result.resources[0].leftUri);
        const rightQuery = decodeJjViewQuery(result.resources[0].rightUri);
        expect(leftQuery.mode).toBe('text');
        if (leftQuery.mode === 'text') {
            expect(leftQuery.text).toContain('remote uploaded description');
        }
        expect(rightQuery.mode).toBe('text');
        if (rightQuery.mode === 'text') {
            expect(rightQuery.text).toContain('local updated description');
        }
    });

    it('detects file modifications and creates uploaded-to-local diff resources', async () => {
        repo.writeFile('file1.txt', 'local modified text');
        const desc = 'test: local commit\n\nChange-Id: I1111222233334444555566667777888899990000';
        repo.describe(desc);
        const changeId = repo.getChangeId('@');

        currentCodeForgeChange = {
            id: 'I1111222233334444555566667777888899990000',
            number: 999,
            displayLabel: 'CL/999',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/999',
            unresolvedComments: 0,
            currentRevision: 'uploaded-sha-123',
            remoteDescription: desc,
            files: {
                'file1.txt': { newSha: 'gerrit-uploaded-blob-sha', status: 'M' },
            },
            synced: false,
            contentSynced: false,
        };

        const result = await computeUnuploadedComparison(mockJjRepo, changeId);
        expect(result.descriptionModified).toBe(false);
        expect(result.unuploadedFilePaths).toContain('file1.txt');
        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].label).toBe('file1.txt');

        const leftQuery = decodeJjViewQuery(result.resources[0].leftUri);
        expect(leftQuery.mode).toBe('uploaded');
        if (leftQuery.mode === 'uploaded') {
            expect(leftQuery.blobSha).toBe('gerrit-uploaded-blob-sha');
            expect(leftQuery.changeNumber).toBe(999);
        }
    });

    it('opens multi-diff editor in compareWithUploadedCommand happy path', async () => {
        repo.writeFile('diff-file.txt', 'content for diff');
        const desc = 'test: commit with changes\n\nChange-Id: I99887766554433221100';
        repo.describe(desc);
        const changeId = repo.getChangeId('@');

        currentCodeForgeChange = {
            id: 'I99887766554433221100',
            number: 555,
            displayLabel: 'CL/555',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/555',
            unresolvedComments: 0,
            currentRevision: 'uploaded-sha-555',
            remoteDescription: desc,
            files: {
                'diff-file.txt': { newSha: 'previous-uploaded-sha', status: 'M' },
            },
            synced: false,
            contentSynced: false,
        };

        await compareWithUploadedCommand(ctx, { revision: changeId });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const multiDiff = ctx.host.nav.multiDiffsOpened[0];
        expect(multiDiff.title).toContain('Uploaded vs Local');
        expect(multiDiff.title).toContain('CL/555');
        expect(multiDiff.resources).toHaveLength(1);
        expect(multiDiff.resources[0].label).toBe('diff-file.txt');
    });

    it('isolates rebase: excludes unrelated upstream file changes and reports clean rebase', async () => {
        repo.writeFile('my-feature.txt', 'feature v1');
        const desc = 'feat: my feature\n\nChange-Id: Iabcdefabcdefabcdefabcdefabcdefabcdefabcd';
        repo.describe(desc);
        const commitId = repo.getCommitId('@');
        const changeId = repo.getChangeId('@');

        const hashes = await jj.getGitBlobHashes(commitId, ['my-feature.txt']);
        const blobSha = hashes.get('my-feature.txt');

        currentCodeForgeChange = {
            id: 'Iabcdefabcdefabcdefabcdefabcdefabcdefabcd',
            number: 777,
            displayLabel: 'CL/777',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/777',
            unresolvedComments: 0,
            currentRevision: 'remote-rebased-rev',
            remoteDescription: desc,
            files: {
                'my-feature.txt': { newSha: blobSha, status: 'A' },
            },
            synced: false,
            parentSynced: false,
            contentSynced: true,
        };

        await compareWithUploadedCommand(ctx, { revision: changeId });

        // Since content matches and only parent differs, no multi-diff is opened
        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(0);
        // Instead, an informative message about the rebase is presented
        expect(ctx.host.ui.infoMessages.some((msg) => msg.includes('Only parent revisions differ due to rebase'))).toBe(
            true,
        );
    });

    it('throws when neither local git store nor forge can resolve uploaded revision details', async () => {
        repo.writeFile('app.ts', 'console.log(1);');
        repo.describe('feat: github style change without files');
        const changeId = repo.getChangeId('@');

        currentCodeForgeChange = {
            id: 'PR_kwDO123',
            number: 42,
            displayLabel: 'PR #42',
            providerName: 'GitHub',
            status: 'NEW',
            submittable: true,
            url: 'https://github.com/owner/repo/pull/42',
            unresolvedComments: 0,
            currentRevision: '0123456789abcdef0123456789abcdef01234567',
        };

        await expect(computeUnuploadedComparison(mockJjRepo, changeId)).rejects.toThrow(
            /Uploaded file metadata is not available/,
        );
    });

    it('resolves Tier 1 uploaded files locally from git when info.files is undefined', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'app.ts': 'base\n' } },
            {
                label: 'uploaded',
                parents: ['base'],
                description: 'feat: uploaded v1',
                files: { 'app.ts': 'uploaded v1\n' },
            },
            {
                label: 'local',
                parents: ['base'],
                description: 'feat: local v2',
                files: { 'app.ts': 'local v2\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fetchUploadedRevisionDetails = vi.fn();
        const githubLikeCodeForge = createMock<CodeForgeService>({
            activeProvider: createMock<CodeForgeProvider>({ changeTerm: 'PR', uploadModel: 'branch-stack' }),
            normalizeDescription: (d) => d.trim(),
            fetchUploadedRevisionDetails,
            populateCodeForgeInfo: (commits) => {
                for (const c of commits) {
                    c.codeForgeChange = {
                        id: 'PR_kwDOlocal',
                        number: 77,
                        displayLabel: '',
                        providerName: 'GitHub',
                        status: 'NEW',
                        submittable: true,
                        url: 'https://github.com/owner/repo/pull/77',
                        unresolvedComments: 0,
                        currentRevision: ids.uploaded.commitId,
                        remoteBaseRevision: ids.base.commitId,
                    };
                }
            },
        });
        const tier1Repo = createMock<JjRepository>({ jj, codeForge: githubLikeCodeForge });

        const result = await computeUnuploadedComparison(tier1Repo, ids.local.changeId);
        expect(fetchUploadedRevisionDetails).not.toHaveBeenCalled();
        expect(result.displayLabel).toBe('PR 77');
        expect(result.descriptionModified).toBe(true);
        expect(result.unuploadedFilePaths).toEqual(['app.ts']);
        expect(result.resources.map((r) => r.label)).toEqual(['COMMIT_MSG', 'app.ts']);
    });

    it('falls back to Tier 2 fetchUploadedRevisionDetails when remote commit is absent locally', async () => {
        repo.writeFile('remote-only.ts', 'local edit');
        repo.describe('feat: tier 2 fallback');
        const changeId = repo.getChangeId('@');

        const fetchUploadedRevisionDetails = vi.fn(async () => ({
            files: { 'remote-only.ts': { newSha: '1111222233334444555566667777888899990000', status: 'M' } },
            remoteDescription: 'feat: tier 2 fallback',
        }));

        const tier2CodeForge = createMock<CodeForgeService>({
            activeProvider: createMock<CodeForgeProvider>({ changeTerm: 'Change', uploadModel: 'revision' }),
            normalizeDescription: (d) => d.trim(),
            fetchUploadedRevisionDetails,
            populateCodeForgeInfo: (commits) => {
                for (const c of commits) {
                    c.codeForgeChange = {
                        id: 'cl-custom-abc',
                        number: 0,
                        displayLabel: '',
                        providerName: 'Custom Forge',
                        status: 'NEW',
                        submittable: false,
                        url: 'https://forge.example.com/cl-custom-abc',
                        unresolvedComments: 0,
                        currentRevision: 'fedcba9876543210fedcba9876543210fedcba98',
                    };
                }
            },
        });

        const tier2Repo = createMock<JjRepository>({ jj, codeForge: tier2CodeForge });
        const result = await computeUnuploadedComparison(tier2Repo, changeId);
        expect(fetchUploadedRevisionDetails).toHaveBeenCalledTimes(1);
        expect(result.displayLabel).toMatch(/^Change /);
        expect(result.unuploadedFilePaths).toEqual(['remote-only.ts']);
        const query = decodeJjViewQuery(result.resources[0].leftUri);
        expect(query.mode).toBe('uploaded');
        if (query.mode === 'uploaded') {
            expect(query.changeId).toBe('cl-custom-abc');
            expect(query.changeNumber).toBe(0);
        }
    });

    it('supports multi-commit branch PR comparison spanning unbookmarked mutable ancestors', async () => {
        const ids = await buildGraph(repo, [
            { label: 'main', description: 'main', files: { 'a.txt': 'v0\n', 'b.txt': 'v0\n' } },
            { label: 'remote1', parents: ['main'], description: 'part 1', files: { 'a.txt': 'v1\n' } },
            { label: 'remote2', parents: ['remote1'], description: 'part 2', files: { 'b.txt': 'v1\n' } },
            { label: 'local1', parents: ['main'], description: 'part 1', files: { 'a.txt': 'v1\n' } },
            {
                label: 'local2',
                parents: ['local1'],
                description: 'part 2 edited',
                files: { 'b.txt': 'v2\n' },
                bookmarks: ['feature-branch'],
                isCurrentWorkingCopy: true,
            },
        ]);

        const branchProvider = createMock<CodeForgeProvider>({
            changeTerm: 'PR',
            uploadModel: 'branch-stack',
            getCachedChangeInfo: () => undefined,
        });
        const branchCodeForge = createMock<CodeForgeService>({
            activeProvider: branchProvider,
            normalizeDescription: (d) => d.trim(),
            populateCodeForgeInfo: (commits) => {
                for (const c of commits) {
                    if (c.commit_id === ids.local2.commitId) {
                        c.codeForgeChange = {
                            id: 'PR_branch',
                            number: 99,
                            displayLabel: 'PR #99',
                            providerName: 'GitHub',
                            status: 'NEW',
                            submittable: true,
                            url: 'https://github.com/owner/repo/pull/99',
                            unresolvedComments: 0,
                            currentRevision: ids.remote2.commitId,
                            remoteBaseRevision: ids.main.commitId,
                            remoteParents: [ids.remote1.commitId],
                        };
                    }
                }
            },
        });
        const branchRepo = createMock<JjRepository>({ jj, codeForge: branchCodeForge });

        const result = await computeUnuploadedComparison(branchRepo, ids.local2.changeId);
        // a.txt matches remote range (v1 == v1), only COMMIT_MSG + b.txt (v1 -> v2) differ
        expect(result.descriptionModified).toBe(true);
        expect(result.unuploadedFilePaths).toEqual(['b.txt']);
    });

    it('falls back to binary byte comparison on non-Git workspaces without gitRoot', async () => {
        repo.new(['root()'], 'citc remote');
        const remotePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);
        const localDiffPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xfe, 0x02]);
        repo.writeFile('same.txt', 'identical');
        repo.writeFile('diff.txt', 'old');
        repo.writeBinaryFile('same.png', remotePng);
        repo.writeBinaryFile('diff.png', remotePng);
        const remoteCommitId = repo.getCommitId('@');

        repo.new(['root()'], 'citc remote');
        repo.writeFile('same.txt', 'identical');
        repo.writeFile('diff.txt', 'new');
        repo.writeBinaryFile('same.png', remotePng);
        repo.writeBinaryFile('diff.png', localDiffPng);
        const localIds = repo.getChangeAndCommitId('@');
        const ids = {
            remote: { commitId: remoteCommitId },
            local: localIds,
        };

        class NonGitHostProcess extends NodeHostProcess {
            override execFile(
                file: string,
                args: readonly string[],
                options?: ProcessExecOptions,
            ): Promise<ProcessResult> {
                if (file.endsWith('jj') && args.includes('git') && args.includes('root')) {
                    return Promise.reject(new ProcessExitError('Not a git repo', 1, '', 'Not a git repo'));
                }
                return super.execFile(file, args, options);
            }
        }
        const nonGitSystem = new NodeHostSystem({ process: new NonGitHostProcess() });
        const nonGitJj = new JjService(repo.path, NO_OP_LOGGER, { system: nonGitSystem });

        const nonGitCodeForge = createMock<CodeForgeService>({
            activeProvider: createMock<CodeForgeProvider>({ changeTerm: 'Change', uploadModel: 'revision' }),
            normalizeDescription: (d) => d.trim(),
            populateCodeForgeInfo: (commits) => {
                for (const c of commits) {
                    c.codeForgeChange = {
                        id: 'citc-100',
                        number: 100,
                        displayLabel: 'Change 100',
                        providerName: 'Custom Forge',
                        status: 'NEW',
                        submittable: true,
                        url: 'https://forge.example.com/100',
                        unresolvedComments: 0,
                        currentRevision: ids.remote.commitId,
                        remoteDescription: 'citc remote',
                        files: {
                            'same.txt': { status: 'M' },
                            'diff.txt': { status: 'M' },
                            'same.png': { status: 'M' },
                            'diff.png': { status: 'M' },
                        },
                    };
                }
            },
        });
        const nonGitRepo = createMock<JjRepository>({ jj: nonGitJj, codeForge: nonGitCodeForge });

        const result = await computeUnuploadedComparison(nonGitRepo, ids.local.changeId);
        expect(result.unuploadedFilePaths).toEqual(['diff.png', 'diff.txt']);
        expect(result.resources).toHaveLength(2);
    });

    it('routes locally reverted remote files to revision=none instead of missing file URI', async () => {
        repo.writeFile('kept.txt', 'still here');
        repo.describe('feat: reverted remote file');
        const commitId = repo.getCommitId('@');
        const changeId = repo.getChangeId('@');
        const keptSha = (await jj.getGitBlobHashes(commitId, ['kept.txt'])).get('kept.txt');

        currentCodeForgeChange = {
            id: 'I9999000011112222333344445555666677778888',
            number: 888,
            displayLabel: 'CL/888',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/888',
            unresolvedComments: 0,
            currentRevision: 'remote-rev-888',
            remoteDescription: 'feat: reverted remote file',
            files: {
                'kept.txt': { newSha: keptSha, status: 'A' },
                'reverted.txt': { newSha: 'deadbeef1234', status: 'A' },
            },
        };

        const result = await computeUnuploadedComparison(mockJjRepo, changeId);
        expect(result.unuploadedFilePaths).toEqual(['reverted.txt']);
        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].rightUri.scheme).toBe('jj-view');
        const rightQuery = decodeJjViewQuery(result.resources[0].rightUri);
        expect(rightQuery.mode).toBe('revision');
        if (rightQuery.mode === 'revision') {
            expect(rightQuery.revision).toBe('none');
        }
    });

    it('recovers from a cold codeForge cache via detectActiveProvider and ensureFreshStatuses', async () => {
        repo.writeFile('cold.txt', 'cold cache content');
        repo.describe('feat: cold cache recovery');
        const changeId = repo.getChangeId('@');

        let warmed = false;
        const detectActiveProvider = vi.fn(async () => true);
        const ensureFreshStatuses = vi.fn(async () => {
            warmed = true;
            return true;
        });

        const coldCodeForge = createMock<CodeForgeService>({
            detectActiveProvider,
            ensureFreshStatuses,
            populateCodeForgeInfo: (commits) => {
                if (!warmed) {
                    return;
                }
                for (const c of commits) {
                    c.codeForgeChange = {
                        id: 'Icold123',
                        number: 321,
                        displayLabel: 'CL/321',
                        providerName: 'Gerrit',
                        status: 'NEW',
                        submittable: false,
                        url: 'https://example.com/c/321',
                        unresolvedComments: 0,
                        currentRevision: 'remote-cold-sha',
                        remoteDescription: 'feat: cold cache recovery',
                        files: {
                            'cold.txt': { newSha: 'older-remote-sha', status: 'A' },
                        },
                    };
                }
            },
        });

        const coldRepo = createMock<JjRepository>({ jj, codeForge: coldCodeForge });
        const result = await computeUnuploadedComparison(coldRepo, changeId);
        expect(detectActiveProvider).toHaveBeenCalledTimes(1);
        expect(ensureFreshStatuses).toHaveBeenCalledTimes(1);
        expect(result.unuploadedFilePaths).toEqual(['cold.txt']);
    });

    it('uses preloaded logEntry and localChanges without re-querying repository', async () => {
        repo.writeFile('preloaded.txt', 'local v2');
        repo.describe('feat: preloaded');
        const [logEntry] = await jj.getLog({ revision: '@', limit: 1, omitChanges: false });
        const localChanges = await jj.getChanges(logEntry.commit_id);

        currentCodeForgeChange = {
            id: 'Ipreloaded',
            number: 654,
            displayLabel: 'CL/654',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/654',
            unresolvedComments: 0,
            currentRevision: 'remote-preloaded',
            remoteDescription: 'feat: preloaded',
            files: {
                'preloaded.txt': { newSha: 'remote-blob-sha', status: 'M' },
            },
        };

        const result = await computeUnuploadedComparison(mockJjRepo, '@', { logEntry, localChanges });
        expect(result.unuploadedFilePaths).toEqual(['preloaded.txt']);
        expect(logEntry.codeForgeChange).toBeUndefined();
    });

    it('omits remote-deleted files also deleted upstream after rebase without phantom none-vs-none diff', async () => {
        repo.writeFile('kept.txt', 'kept');
        repo.describe('feat: deletion matched upstream');
        const changeId = repo.getChangeId('@');
        const commitId = repo.getCommitId('@');

        currentCodeForgeChange = {
            id: 'Idelmatch',
            number: 801,
            displayLabel: 'CL/801',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/801',
            unresolvedComments: 0,
            currentRevision: 'remote-del-match',
            remoteDescription: 'feat: deletion matched upstream',
            files: {
                'kept.txt': {
                    newSha: (await jj.getGitBlobHashes(commitId, ['kept.txt'])).get('kept.txt'),
                    status: 'A',
                },
                'upstream-removed.txt': { status: 'D' },
            },
        };

        const result = await computeUnuploadedComparison(mockJjRepo, changeId);
        expect(result.unuploadedFilePaths).toEqual([]);
        expect(result.resources).toEqual([]);
        expect(result.isContentSynced).toBe(true);
    });

    it('surfaces implied remote deletion oldPath when a remote rename is locally reverted', async () => {
        repo.writeFile('old-name.txt', 'original content\n');
        repo.describe('base');
        repo.new(['@'], 'feat: revert rename locally');
        const changeId = repo.getChangeId('@');

        currentCodeForgeChange = {
            id: 'Irenamerevert',
            number: 802,
            displayLabel: 'CL/802',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: false,
            url: 'https://example.com/c/802',
            unresolvedComments: 0,
            currentRevision: 'remote-renamed',
            remoteDescription: 'feat: revert rename locally',
            files: {
                'new-name.txt': { status: 'R', oldPath: 'old-name.txt', newSha: 'remote-new-sha' },
            },
        };

        const result = await computeUnuploadedComparison(mockJjRepo, changeId);
        expect(result.unuploadedFilePaths).toEqual(['new-name.txt', 'old-name.txt']);
        const oldEntry = result.resources.find((r) => r.label === 'old-name.txt');
        expect(oldEntry).toBeDefined();
        if (oldEntry) {
            const leftQuery = decodeJjViewQuery(oldEntry.leftUri);
            expect(leftQuery.mode).toBe('revision');
            if (leftQuery.mode === 'revision') {
                expect(leftQuery.revision).toBe('none');
            }
        }
    });

    it('reads empty, root, renamed, and deleted git commit details and clears caches on jj.clearCache()', async () => {
        // Root commit with added files + empty description commit + rename + deletion
        repo.new(['root()'], 'root commit');
        repo.writeFile('alpha.txt', 'hello world alpha\n');
        repo.writeFile('delete-me.txt', 'bye\n');
        const rootCommitId = repo.getCommitId('@');

        repo.new([rootCommitId], '');
        const emptyCommitId = repo.getCommitId('@');

        repo.new([rootCommitId], 'rename and delete');
        repo.moveFile('alpha.txt', 'beta.txt');
        repo.deleteFile('delete-me.txt');
        const headCommitId = repo.getCommitId('@');

        const rootDetails = await jj.getGitCommitDetails(rootCommitId);
        expect(rootDetails?.description).toBe('root commit');
        expect(rootDetails?.files['alpha.txt']?.status).toBe('A');
        expect(rootDetails?.files['delete-me.txt']?.status).toBe('A');

        const emptyDetails = await jj.getGitCommitDetails(emptyCommitId);
        expect(emptyDetails?.description).toBe('');
        expect(emptyDetails?.files).toEqual({});

        const headDetails = await jj.getGitCommitDetails(headCommitId);
        expect(headDetails?.description).toBe('rename and delete');
        expect(headDetails?.files['beta.txt']).toMatchObject({ status: 'R', oldPath: 'alpha.txt' });
        expect(headDetails?.files['delete-me.txt']?.status).toBe('D');

        const rangeFiles = await jj.getGitRangeFiles(rootCommitId, headCommitId);
        expect(rangeFiles?.['beta.txt']).toMatchObject({ status: 'R', oldPath: 'alpha.txt' });
        expect(rangeFiles?.['delete-me.txt']?.status).toBe('D');

        await jj.clearCache();
        const reloadedRange = await jj.getGitRangeFiles(rootCommitId, headCommitId);
        expect(reloadedRange).toEqual(rangeFiles);
    });
});
