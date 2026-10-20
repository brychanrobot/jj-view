/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeForgeService } from '../../core/code-forge-service';
import { compareWithUploadedCommand, computeUnuploadedComparison } from '../../core/commands/compare-with-uploaded';
import type { JjRepository } from '../../core/jj-repository';
import type { CodeForgeChangeInfo } from '../../core/jj-schemas';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { decodeJjViewQuery } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
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
});
