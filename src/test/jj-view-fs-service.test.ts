/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { JjViewFsService } from '../core/jj-view-fs-service';
import { createTextContentUri, createUploadedFileUri, Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('JjViewFsService Unit Tests', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let service: JjViewFsService;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, host);

        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        service = new JjViewFsService(repoManager);
    });

    afterEach(async () => {
        await repoManager.dispose();
        await repo.dispose();
    });

    it('throws error when no repository is found', async () => {
        const outsideUri = Uri.parse('jj-view:///outside/file.txt#root=/outside&revision=@');
        await expect(service.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });

    it('reads file content at a specific revision', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'version 1' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        const bytes = await service.readFile(uri);
        expect(Buffer.from(bytes).toString('utf8')).toBe('version 1');
    });

    it('invalidates cache and emits onDidChangeFile', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'initial content' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        await service.readFile(uri);

        let firedUris: Uri[] = [];
        service.onDidChangeFile((uris) => {
            firedUris = uris;
        });

        const invalidated = service.invalidateCache();
        expect(invalidated.length).toBe(1);
        expect(firedUris.length).toBe(1);
        expect(firedUris[0].toString()).toBe(uri.toString());

        // A second invalidation without new reads or watchers should not fire
        firedUris = [];
        const secondInvalidation = service.invalidateCache();
        expect(secondInvalidation.length).toBe(0);
        expect(firedUris.length).toBe(0);
    });

    it('watch keeps URI notified across repeated cache invalidations', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'initial content' } },
        ]);

        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${nodes.initial.changeId}`,
        });

        const watcher = service.watch(uri);

        let fireCount = 0;
        service.onDidChangeFile(() => {
            fireCount++;
        });

        service.invalidateCache();
        expect(fireCount).toBe(1);

        service.invalidateCache();
        expect(fireCount).toBe(2);

        watcher.dispose();

        service.invalidateCache();
        expect(fireCount).toBe(2);
    });

    it('watch disposable is idempotent and does not prematurely unwatch shared URIs', async () => {
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const watcher1 = service.watch(uri);
        const watcher2 = service.watch(uri);

        let fireCount = 0;
        service.onDidChangeFile(() => {
            fireCount++;
        });

        // Dispose watcher 1 multiple times
        watcher1.dispose();
        watcher1.dispose();

        // Watcher 2 is still active, so invalidateCache should still notify uri
        service.invalidateCache();
        expect(fireCount).toBe(1);

        watcher2.dispose();
        service.invalidateCache();
        expect(fireCount).toBe(1);
    });

    it('stat returns monotonic mtime advancing on invalidateCache', () => {
        const uri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const statBefore = service.stat(uri);
        expect(statBefore.type).toBe(1);
        expect(statBefore.mtime).toBeGreaterThan(1700000000000 - 1);

        service.invalidateCache();
        const statAfter = service.stat(uri);
        expect(statAfter.mtime).toBe(statBefore.mtime + 1);
    });

    it('concurrent left and right diff reads resolve correct contents', async () => {
        const nodes = await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'f.txt': 'v1\n' } },
            { label: 'second', description: 'second', parents: ['initial'], files: { 'f.txt': 'v2\n' } },
        ]);

        const leftUri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&base=${nodes.second.changeId}&side=left`,
        });
        const rightUri = Uri.from({
            scheme: 'jj-view',
            path: '/f.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&base=${nodes.second.changeId}&side=right`,
        });

        const [leftBytes, rightBytes] = await Promise.all([service.readFile(leftUri), service.readFile(rightUri)]);

        expect(Buffer.from(leftBytes).toString('utf8')).toBe('v1\n');
        expect(Buffer.from(rightBytes).toString('utf8')).toBe('v2\n');
    });
    it('preserves exact non-UTF-8 binary bytes for image diffs and revision reads', async () => {
        const pngV1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
        const pngV2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x80, 0x99, 0xab]);

        repo.writeBinaryFile('logo.png', pngV1);
        repo.describe('v1 binary');
        const v1ChangeId = repo.getChangeId('@');

        repo.new();
        repo.writeBinaryFile('logo.png', pngV2);
        repo.describe('v2 binary');
        const v2ChangeId = repo.getChangeId('@');

        const leftUri = Uri.from({
            scheme: 'jj-view',
            path: '/logo.png',
            fragment: `root=${encodeURIComponent(repo.path)}&base=${v2ChangeId}&side=left`,
        });
        const rightUri = Uri.from({
            scheme: 'jj-view',
            path: '/logo.png',
            fragment: `root=${encodeURIComponent(repo.path)}&base=${v2ChangeId}&side=right`,
        });
        const revUri = Uri.from({
            scheme: 'jj-view',
            path: '/logo.png',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=${v1ChangeId}`,
        });

        const [leftBytes, rightBytes, revBytes] = await Promise.all([
            service.readFile(leftUri),
            service.readFile(rightUri),
            service.readFile(revUri),
        ]);

        expect(Buffer.from(leftBytes).equals(pngV1)).toBe(true);
        expect(Buffer.from(rightBytes).equals(pngV2)).toBe(true);
        expect(Buffer.from(revBytes).equals(pngV1)).toBe(true);
    });

    it('reads text mode content correctly', async () => {
        const textUri = createTextContentUri(repo.path, 'COMMIT_MSG', 'Subject line\n\nCommit body');
        const bytes = await service.readFile(textUri);
        expect(Buffer.from(bytes).toString('utf8')).toBe('Subject line\n\nCommit body');
    });

    it('reads uploaded content via git blobSha', async () => {
        repo.writeFile('uploaded.txt', 'uploaded content from blob');
        const commitId = repo.getCommitId('@');
        const repoInstance = repoManager.getRepositoryForUri(Uri.file(repo.path));
        if (!repoInstance) {
            throw new Error('repoInstance not found');
        }

        const hashes = await repoInstance.jj.getGitBlobHashes(commitId, ['uploaded.txt']);
        const blobSha = hashes.get('uploaded.txt');
        expect(blobSha).toBeDefined();

        const uploadedUri = createUploadedFileUri(repo.path, 'uploaded.txt', {
            changeId: 'I12345',
            blobSha,
        });

        const bytes = await service.readFile(uploadedUri);
        expect(Buffer.from(bytes).toString('utf8')).toBe('uploaded content from blob');
    });

    it('reads uploaded content via remoteRevision when blobSha is absent', async () => {
        repo.writeFile('remote.txt', 'remote revision file content');
        const commitId = repo.getCommitId('@');

        const uploadedUri = createUploadedFileUri(repo.path, 'remote.txt', {
            changeId: 'I67890',
            remoteRevision: commitId,
        });

        const bytes = await service.readFile(uploadedUri);
        expect(Buffer.from(bytes).toString('utf8')).toBe('remote revision file content');
    });

    it('preserves exact binary bytes for uploaded images with blobSha and remoteRevision or forge fallback', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
        repo.writeBinaryFile('banner.png', pngBytes);
        const commitId = repo.getCommitId('@');
        const repoInstance = repoManager.getRepositoryForUri(Uri.file(repo.path));
        if (!repoInstance) {
            throw new Error('repoInstance not found');
        }
        const hashes = await repoInstance.jj.getGitBlobHashes(commitId, ['banner.png']);
        const blobSha = hashes.get('banner.png');
        expect(blobSha).toBeDefined();

        const localUploadedUri = createUploadedFileUri(repo.path, 'banner.png', {
            changeId: 'Iimglocal',
            blobSha,
            remoteRevision: commitId,
        });
        const localBytes = await service.readFile(localUploadedUri);
        expect(Buffer.from(localBytes).equals(pngBytes)).toBe(true);

        const spy = vi
            .spyOn(repoInstance.codeForge, 'getUploadedFileContent')
            .mockResolvedValue(new Uint8Array(pngBytes));
        const remoteOnlyUri = createUploadedFileUri(repo.path, 'banner.png', {
            changeId: 'Iimgremote',
            blobSha: '0123456789abcdef0123456789abcdef01234567',
            remoteRevision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            changeNumber: 4242,
        });
        const remoteBytes = await service.readFile(remoteOnlyUri);
        expect(spy).toHaveBeenCalledWith(4242, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'banner.png');
        expect(Buffer.from(remoteBytes).equals(pngBytes)).toBe(true);
    });

    it('reads git blob content in non-colocated repos and secondary workspaces, and rejects invalid blobSha', async () => {
        const secondaryParent = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-ws-sec-'));
        const nonColocatedRepo = new TestRepo();
        try {
            const primaryJj = new JjService(repo.path, NO_OP_LOGGER);
            repo.writeFile('ws.txt', 'hello secondary workspace');
            const commitId = repo.getCommitId('@');
            const hashes = await primaryJj.getGitBlobHashes(commitId, ['ws.txt']);
            const blobSha = hashes.get('ws.txt');
            if (!blobSha) {
                throw new Error('Expected blobSha for ws.txt');
            }

            const wsPath = path.join(secondaryParent, 'sec');
            await primaryJj.workspaceAdd(wsPath, 'sec');
            const secJj = new JjService(wsPath, NO_OP_LOGGER);
            expect(await secJj.getGitBlobContent(blobSha)).toBe('hello secondary workspace');
            expect(await secJj.getGitBlobContent('--help')).toBeUndefined();
            expect(await secJj.getGitBlobContent('-p')).toBeUndefined();

            nonColocatedRepo.init({ colocate: false });
            nonColocatedRepo.writeFile('nc.txt', 'hello non-colocated');
            const ncCommitId = nonColocatedRepo.getCommitId('@');
            const ncJj = new JjService(nonColocatedRepo.path, NO_OP_LOGGER);
            const ncHashes = await ncJj.getGitBlobHashes(ncCommitId, ['nc.txt']);
            const ncBlobSha = ncHashes.get('nc.txt');
            expect(ncBlobSha).toBeDefined();
            if (ncBlobSha) {
                expect(await ncJj.getGitBlobContent(ncBlobSha)).toBe('hello non-colocated');
            }
        } finally {
            await nonColocatedRepo.dispose();
            await fs.rm(secondaryParent, { recursive: true, force: true });
        }
    });
});
