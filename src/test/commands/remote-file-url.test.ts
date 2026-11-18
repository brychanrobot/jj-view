/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyRemoteFileUrlCommand, openFileOnRemoteCommand } from '../../core/commands/remote-file-url';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { createDiffUris, createRevisionUri, createUploadedFileUri, Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { ScopedTempDir } from '../scoped-helpers';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

function setRemoteUrl(repoPath: string, name: string, url: string): void {
    cp.execFileSync(TestRepo.getJjBinary(), ['git', 'remote', 'set-url', name, url], {
        cwd: repoPath,
        stdio: 'ignore',
    });
}

describe('remote file link commands (non-colocated TestRepo)', () => {
    let repo: TestRepo;
    let bareRemoteDir: ScopedTempDir;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init({ colocate: false });
        bareRemoteDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-bare-remote-'));
        cp.execFileSync(TestRepo.getGitBinary(), ['init', '--bare', bareRemoteDir.path], {
            stdio: 'ignore',
        });

        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            rootUri: Uri.file(repo.path),
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(async () => {
        vi.clearAllMocks();
        bareRemoteDir?.[Symbol.dispose]();
        await repo.dispose();
    });

    it('resolves git_web_url preferring origin over other remotes in non-colocated repos', async () => {
        expect(fs.existsSync(path.join(repo.path, '.git'))).toBe(false);
        expect(await jj.getGitWebUrl()).toBeUndefined();

        repo.addRemote('upstream', 'https://github.com/upstream-org/project.git');
        expect(await jj.getGitWebUrl()).toBe('https://github.com/upstream-org/project');

        repo.addRemote('origin', 'git@github.com:origin-org/project.git');
        expect(await jj.getGitWebUrl()).toBe('https://github.com/origin-org/project');
        expect(await jj.getGitWebUrl('upstream')).toBe('https://github.com/upstream-org/project');
    });

    it('resolves working-copy and unpushed commits to pushed remote bookmark ancestor in non-colocated repo', async () => {
        expect(fs.existsSync(path.join(repo.path, '.git'))).toBe(false);

        repo.addRemote('origin', bareRemoteDir.path);
        repo.writeFile('src/my file.ts', 'line 1\nline 2\nline 3\nline 4\nline 5\n');
        repo.describe('pushed commit');
        repo.bookmark('main', '@');
        const pushedCommitSha = repo.getCommitId('@');
        repo.gitPush('main');

        // Point origin to a GitHub remote URL after pushing so main@origin stays recorded on pushedCommitSha
        setRemoteUrl(repo.path, 'origin', 'https://github.com/acme/non-colocated.git');

        // Add an unpushed commit and an unpushed working-copy commit on top
        repo.new(undefined, 'unpushed local commit');
        repo.writeFile('src/local-only.ts', 'hello\n');
        const unpushedChangeId = repo.getChangeId('@');

        repo.new(undefined, 'working copy edit');
        repo.writeFile('src/my file.ts', 'edited locally\n');

        const workingCopyFileUri = Uri.file(path.join(repo.path, 'src', 'my file.ts'));
        ctx.host.documents.setActiveDocument(workingCopyFileUri, [{ startLine: 1, endLine: 4 }]);

        await copyRemoteFileUrlCommand(ctx, { fileUri: workingCopyFileUri });
        expect(ctx.host.nav.clipboardText).toBe(
            `https://github.com/acme/non-colocated/blob/${pushedCommitSha}/src/my%20file.ts#L2-L5`,
        );
        expect(ctx.host.ui.infoMessages).toContain('Copied remote link for src/my file.ts.');

        // Unpushed non-working-copy commit also resolves to its pushed remote bookmark ancestor
        await openFileOnRemoteCommand(ctx, {
            filePath: 'src/my file.ts',
            isRepoRelative: true,
            revision: unpushedChangeId,
            skipActiveSelection: true,
        });
        expect(ctx.host.nav.externalUrisOpened.map((u) => u.toString())).toEqual([
            `https://github.com/acme/non-colocated/blob/${pushedCommitSha}/src/my%20file.ts`,
        ]);
    });

    it('handles jj-view:// diff left/right sides (including renamed oldPath) and jj-edit:// URIs', async () => {
        repo.addRemote('origin', bareRemoteDir.path);
        repo.writeFile('old/name.ts', 'v1\n');
        repo.describe('v1 commit');
        const v1Sha = repo.getCommitId('@');

        repo.new(undefined, 'v2 rename');
        repo.deleteFile('old/name.ts');
        repo.writeFile('new/name.ts', 'v2\n');
        repo.bookmark('main', '@');
        const v2Sha = repo.getCommitId('@');
        const v2ChangeId = repo.getChangeId('@');
        repo.gitPush('main');

        setRemoteUrl(repo.path, 'origin', 'https://github.com/acme/app.git');
        repo.new(undefined, 'wc');

        const diffUris = createDiffUris(
            {
                status: 'renamed',
                path: 'new/name.ts',
                oldPath: 'old/name.ts',
                conflicted: false,
            },
            v2ChangeId,
            repo.path,
            { editable: true },
        );

        await copyRemoteFileUrlCommand(ctx, {
            fileUri: diffUris.leftUri,
            lineRange: { startLine: 3 },
        });
        expect(ctx.host.nav.clipboardText).toBe(`https://github.com/acme/app/blob/${v1Sha}/old/name.ts#L3`);

        await openFileOnRemoteCommand(ctx, {
            fileUri: diffUris.rightUri,
        });
        expect(ctx.host.nav.externalUrisOpened[0].toString()).toBe(
            `https://github.com/acme/app/blob/${v2Sha}/new/name.ts`,
        );

        // Deleted file on pushed commit resolves to its parent commit SHA where the file existed
        await copyRemoteFileUrlCommand(ctx, {
            filePath: 'old/name.ts',
            isRepoRelative: true,
            revision: v2Sha,
            fileStatus: 'deleted',
            skipActiveSelection: true,
        });
        expect(ctx.host.nav.clipboardText).toBe(`https://github.com/acme/app/blob/${v1Sha}/old/name.ts`);
    });

    it('supports jj-view.gitlab.host for self-hosted GitLab SSH remotes and jj-view.gerrit.host for Gerrit Gitiles', async () => {
        repo.addRemote('origin', bareRemoteDir.path);
        repo.writeFile('lib/core.ts', 'export const x = 1;\n');
        repo.describe('pushed commit');
        repo.bookmark('main', '@');
        const pushedSha = repo.getCommitId('@');
        repo.gitPush('main');

        repo.new(undefined, 'wc');

        // 1. Bare local remote + configured Gerrit host/project (no git_web_url from jj)
        ctx.host.config.set('gerrit.host', 'https://gerrit.example.com');
        ctx.host.config.set('gerrit.project', 'platform/core');

        const revUri = createRevisionUri(repo.path, path.join(repo.path, 'lib', 'core.ts'), pushedSha);
        await copyRemoteFileUrlCommand(ctx, {
            fileUri: revUri,
            lineRange: { startLine: 7, endLine: 9 },
        });
        expect(ctx.host.nav.clipboardText).toBe(
            `https://gerrit.example.com/plugins/gitiles/platform/core/+/${pushedSha}/lib/core.ts#7`,
        );

        // 2. Self-hosted GitLab SSH remote + configured gitlab.host
        ctx.host.config.set('gerrit.host', undefined);
        ctx.host.config.set('gerrit.project', undefined);
        ctx.host.config.set('gitlab.host', 'https://code.internal.org');
        setRemoteUrl(repo.path, 'origin', 'git@code.internal.org:team/service.git');

        await copyRemoteFileUrlCommand(ctx, {
            fileUri: revUri,
            lineRange: { startLine: 4, endLine: 10 },
        });
        expect(ctx.host.nav.clipboardText).toBe(
            `https://code.internal.org/team/service/-/blob/${pushedSha}/lib/core.ts#L4-10`,
        );
    });

    it('warns clearly on missing remotes, files outside the repository, and directories', async () => {
        repo.writeFile('tracked.txt', 'hello\n');
        const trackedUri = Uri.file(path.join(repo.path, 'tracked.txt'));

        // No git remotes configured
        await copyRemoteFileUrlCommand(ctx, { fileUri: trackedUri });
        expect(ctx.host.nav.clipboardText).toBe('');
        expect(ctx.host.ui.warningMessages).toContain('No Git remote is configured for this repository.');

        // Configure remote, then test file outside repo
        repo.addRemote('origin', 'https://github.com/acme/repo.git');
        using outsideDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-outside-'));
        const outsideFile = path.join(outsideDir.path, 'outside.txt');
        fs.writeFileSync(outsideFile, 'nope\n');

        await openFileOnRemoteCommand(ctx, { fileUri: Uri.file(outsideFile) });
        expect(ctx.host.nav.externalUrisOpened).toHaveLength(0);
        expect(ctx.host.ui.warningMessages.some((m) => m.includes('outside the Jujutsu repository'))).toBe(true);

        // Directory target inside repo
        fs.mkdirSync(path.join(repo.path, 'subdir'), { recursive: true });
        await copyRemoteFileUrlCommand(ctx, { fileUri: Uri.file(path.join(repo.path, 'subdir')) });
        expect(ctx.host.ui.warningMessages.some((m) => m.includes('rather than a folder'))).toBe(true);
    });

    it('resolves strictly behind tracked remote bookmarks, deleted right-side diffs, merge parents, uploaded SHAs, and secondary workspaces', async () => {
        repo.addRemote('origin', bareRemoteDir.path);
        const ids = await buildGraph(repo, [
            {
                label: 'base',
                parents: ['root()'],
                description: 'base',
                files: { 'file.ts': 'base\n', 'doomed.ts': 'gone later\n' },
            },
            { label: 'featMid', parents: ['base'], description: 'pushed mid', files: { 'file.ts': 'mid\n' } },
            { label: 'featTip', parents: ['featMid'], description: 'pushed tip', files: { 'file.ts': 'tip\n' } },
        ]);
        repo.bookmark('main', ids.base.changeId);
        repo.bookmark('feat', ids.featTip.changeId);
        repo.gitPush('main');
        repo.gitPush('feat');

        // Deleted commit pushed on its own remote bookmark before switching origin URL to GitHub
        repo.new([ids.base.changeId], 'delete doomed');
        repo.deleteFile('doomed.ts');
        const deleteChangeId = repo.getChangeId('@');
        repo.bookmark('del-branch', '@');
        repo.gitPush('del-branch');

        setRemoteUrl(repo.path, 'origin', 'https://github.com/acme/edge-cases.git');

        // 1. Working copy branched strictly behind feat@origin (featMid -> unpushedBranch -> @)
        repo.new([ids.featMid.changeId], 'unpushed branch');
        repo.writeFile('file.ts', 'local branch\n');
        repo.new(undefined, 'wc on branch');
        repo.writeFile('file.ts', 'wc local\n');

        await copyRemoteFileUrlCommand(ctx, { fileUri: Uri.file(path.join(repo.path, 'file.ts')) });
        expect(ctx.host.nav.clipboardText).toBe(
            `https://github.com/acme/edge-cases/blob/${ids.featMid.commitId}/file.ts`,
        );

        // 2. Deleted file opened on jj-view:// side=right without explicit fileStatus steps to parent commit
        const deletedDiff = createDiffUris(
            { status: 'deleted', path: 'doomed.ts', conflicted: false },
            deleteChangeId,
            repo.path,
        );
        await copyRemoteFileUrlCommand(ctx, { fileUri: deletedDiff.rightUri });
        expect(ctx.host.nav.clipboardText).toBe(
            `https://github.com/acme/edge-cases/blob/${ids.base.commitId}/doomed.ts`,
        );

        // 3. Merge commit side=left resolves a deterministic single parent rather than failing on ambiguity
        const mergeGraph = await buildGraph(repo, [
            { label: 'p1', parents: [ids.base.changeId], description: 'p1', files: { 'file.ts': 'p1\n' } },
            { label: 'p2', parents: [ids.base.changeId], description: 'p2', files: { 'other.ts': 'p2\n' } },
            { label: 'merge', parents: ['p1', 'p2'], description: 'merge', files: { 'file.ts': 'merged\n' } },
        ]);
        const mergeLeftDiff = createDiffUris(
            { status: 'modified', path: 'file.ts', conflicted: false },
            mergeGraph.merge.changeId,
            repo.path,
        );
        await copyRemoteFileUrlCommand(ctx, { fileUri: mergeLeftDiff.leftUri });
        expect(ctx.host.nav.clipboardText).toMatch(
            /^https:\/\/github\.com\/acme\/edge-cases\/blob\/[0-9a-f]{40}\/file\.ts$/,
        );

        // 4. compareWithUploaded mode=uploaded links directly to unfetched remote SHA; revision=none warns cleanly
        const unfetchedSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
        const uploadedUri = createUploadedFileUri(repo.path, 'file.ts', {
            changeId: 'unknown-change',
            commitId: unfetchedSha,
            remoteRevision: unfetchedSha,
        });
        await copyRemoteFileUrlCommand(ctx, { fileUri: uploadedUri });
        expect(ctx.host.nav.clipboardText).toBe(`https://github.com/acme/edge-cases/blob/${unfetchedSha}/file.ts`);

        const noneUri = createRevisionUri(repo.path, path.join(repo.path, 'file.ts'), 'none');
        await openFileOnRemoteCommand(ctx, { fileUri: noneUri });
        expect(ctx.host.ui.warningMessages).toContain('File does not exist in this revision.');

        // 5. Secondary non-colocated workspace resolves repo-relative path cleanly
        using wsDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-ws2-'));
        const wsPath = path.join(wsDir.path, 'secondary-ws');
        const wsRepo = repo.workspaceAdd('ws2', undefined, wsPath);
        const wsJj = new JjService(wsRepo.path, NO_OP_LOGGER);
        const wsMockRepo = createMock<JjRepository>({
            jj: wsJj,
            rootUri: Uri.file(wsRepo.path),
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        const wsCtx = new FakeCommandContext(wsMockRepo);
        wsCtx.host.nav.clipboardText = '';
        await copyRemoteFileUrlCommand(wsCtx, {
            fileUri: Uri.file(path.join(wsRepo.path, 'file.ts')),
        });
        expect(wsCtx.host.nav.clipboardText).toMatch(
            /^https:\/\/github\.com\/acme\/edge-cases\/blob\/[0-9a-f]{40}\/file\.ts$/,
        );
    });

    it('handles single-commit repos rooted on root() and warns when linking left side of initial commit', async () => {
        repo.addRemote('origin', 'https://github.com/acme/fresh.git');
        repo.writeFile('init.ts', 'hello\n');
        repo.describe('first commit');
        const firstSha = repo.getCommitId('@');
        const firstChange = repo.getChangeId('@');

        await copyRemoteFileUrlCommand(ctx, { fileUri: Uri.file(path.join(repo.path, 'init.ts')) });
        expect(ctx.host.nav.clipboardText).toBe(`https://github.com/acme/fresh/blob/${firstSha}/init.ts`);

        const initLeft = createDiffUris(
            { status: 'added', path: 'init.ts', conflicted: false },
            firstChange,
            repo.path,
        );
        await openFileOnRemoteCommand(ctx, { fileUri: initLeft.leftUri });
        expect(ctx.host.ui.warningMessages).toContain('Cannot generate a remote file link for the root commit.');
    });
});
