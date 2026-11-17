/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    formatRootFileFileset,
    resolveWorkspaceRelativePath,
    restoreFileFromRevisionCommand,
} from '../../core/commands/restore-file-from-revision';
import type { HostFs } from '../../core/host/host-system';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { ScopedSymlink, ScopedTempDir } from '../scoped-helpers';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('restoreFileFromRevisionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
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
        await repo.dispose();
    });

    it('restores a modified file from an ancestor revision when revision is provided in payload', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'notes.txt': 'v1 content\n' } },
            {
                label: 'middle',
                parents: ['base'],
                description: 'middle commit',
                files: { 'notes.txt': 'v2 content\n' },
            },
            {
                label: 'current',
                parents: ['middle'],
                description: 'current commit',
                files: { 'notes.txt': 'v3 working copy\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, 'notes.txt'));

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: ids.base.changeId });

        expect(fs.readFileSync(path.join(repo.path, 'notes.txt'), 'utf-8')).toBe('v1 content\n');
        expect(ctx.host.ui.quickPickCalls).toHaveLength(0);
        expect(ctx.host.ui.progressTitles).toContain(`Restoring notes.txt from ${ids.base.changeId}...`);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'restoreFileFrom' });
    });

    it('prompts with visible revisions and restores a modified file from a sibling revision', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root commit', files: { 'shared.txt': 'root content\n' } },
            {
                label: 'sibling',
                parents: ['root'],
                description: 'sibling branch',
                files: { 'shared.txt': 'sibling content\n' },
            },
            {
                label: 'current',
                parents: ['root'],
                description: 'current branch',
                files: { 'shared.txt': 'current content\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, 'shared.txt'));
        ctx.host.ui.setNextRevisionPromptResponse(ids.sibling.changeId);

        await restoreFileFromRevisionCommand(ctx, { fileUri });

        expect(fs.readFileSync(path.join(repo.path, 'shared.txt'), 'utf-8')).toBe('sibling content\n');
        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(ctx.host.ui.quickPickCalls[0].options?.placeHolder).toBe('Select a revision to restore shared.txt from');
        const promptedValues = ctx.host.ui.quickPickCalls[0].items.map((item) => item.value);
        expect(promptedValues).toContain(ids.sibling.changeId);
        expect(promptedValues).toContain(ids.root.changeId);
        expect(ctx.host.ui.progressTitles).toContain(`Restoring shared.txt from ${ids.sibling.changeId}...`);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'restoreFileFrom' });
    });

    it('restores a deleted file from a previous revision', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'subdir/deleted.txt': 'restored content\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                isCurrentWorkingCopy: true,
            },
        ]);

        repo.deleteFile('subdir/deleted.txt');
        expect(fs.existsSync(path.join(repo.path, 'subdir/deleted.txt'))).toBe(false);

        const fileUri = Uri.file(path.join(repo.path, 'subdir/deleted.txt'));
        ctx.host.ui.setNextRevisionPromptResponse(ids.base.changeId);

        await restoreFileFromRevisionCommand(ctx, { fileUri });

        expect(fs.existsSync(path.join(repo.path, 'subdir/deleted.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(repo.path, 'subdir/deleted.txt'), 'utf-8')).toBe('restored content\n');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'restoreFileFrom' });
    });

    it('returns early without modifying file or refreshing when revision prompt is cancelled', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'cancel.txt': 'original\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { 'cancel.txt': 'modified\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, 'cancel.txt'));
        ctx.host.ui.setNextRevisionPromptResponse(undefined);

        await restoreFileFromRevisionCommand(ctx, { fileUri });

        expect(fs.readFileSync(path.join(repo.path, 'cancel.txt'), 'utf-8')).toBe('modified\n');
        expect(ctx.host.ui.progressTitles).toHaveLength(0);
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    it('shows error and returns early when fileUri is missing or has a non-file scheme', async () => {
        await restoreFileFromRevisionCommand(ctx);
        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('No workspace file selected to restore.');

        const virtualUri = Uri.from({ scheme: 'jj-view', path: '/notes.txt' });
        await restoreFileFromRevisionCommand(ctx, { fileUri: virtualUri, revision: 'main' });
        expect(ctx.host.ui.errorMessages).toHaveLength(2);
        expect(ctx.host.ui.errorMessages[1]).toContain('Restore File Error');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    it('shows error when restoring from an invalid revision fails', async () => {
        repo.writeFile('file.txt', 'current\n');
        const fileUri = Uri.file(path.join(repo.path, 'file.txt'));

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: 'nonexistent-rev-xyz' });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Failed to restore file from revision');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    it('trims whitespace around payload revision and falls back to prompt when revision is whitespace-only', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'trim.txt': 'base content\n' } },
            {
                label: 'other',
                parents: ['base'],
                description: 'other commit',
                files: { 'trim.txt': 'other content\n' },
            },
            {
                label: 'current',
                parents: ['other'],
                description: 'current commit',
                files: { 'trim.txt': 'working copy content\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, 'trim.txt'));

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: `  ${ids.other.changeId}  ` });
        expect(fs.readFileSync(path.join(repo.path, 'trim.txt'), 'utf-8')).toBe('other content\n');
        expect(ctx.host.ui.quickPickCalls).toHaveLength(0);

        ctx.host.ui.setNextRevisionPromptResponse('   ');
        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: '   ' });
        expect(ctx.host.ui.quickPickCalls).toHaveLength(1);
        expect(fs.readFileSync(path.join(repo.path, 'trim.txt'), 'utf-8')).toBe('other content\n');

        ctx.host.ui.setNextRevisionPromptResponse(ids.base.changeId);
        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: '   ' });
        expect(fs.readFileSync(path.join(repo.path, 'trim.txt'), 'utf-8')).toBe('base content\n');
        expect(mockJjRepo.refresh).toHaveBeenCalledTimes(2);
    });

    it('removes a newly added file when restoring from an ancestor where it did not exist', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'existing.txt': 'keep\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { 'added.txt': 'new file content\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const filePath = path.join(repo.path, 'added.txt');
        expect(fs.existsSync(filePath)).toBe(true);

        await restoreFileFromRevisionCommand(ctx, { fileUri: Uri.file(filePath), revision: ids.base.changeId });

        expect(fs.existsSync(filePath)).toBe(false);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'restoreFileFrom' });
    });

    it('shows error and returns early when fileUri points to a directory or workspace root', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'subdir/keep.txt': 'v1\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { 'subdir/keep.txt': 'v2\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await restoreFileFromRevisionCommand(ctx, { fileUri: Uri.file(repo.path), revision: ids.base.changeId });
        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Cannot restore a directory.');

        await restoreFileFromRevisionCommand(ctx, {
            fileUri: Uri.file(path.join(repo.path, 'subdir')),
            revision: ids.base.changeId,
        });
        expect(ctx.host.ui.errorMessages).toHaveLength(2);
        expect(ctx.host.ui.errorMessages[1]).toContain('Cannot restore a directory.');
        expect(fs.readFileSync(path.join(repo.path, 'subdir/keep.txt'), 'utf-8')).toBe('v2\n');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    it('flushes dirty document buffer via saveIfDirty before restoring', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'dirty.txt': 'clean\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { 'dirty.txt': 'saved\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, 'dirty.txt'));
        ctx.host.documents.setDocumentText(fileUri, 'unsaved editor draft\n');

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: ids.base.changeId });

        expect(ctx.host.documents.savedUris).toContain(fileUri);
        expect(fs.readFileSync(path.join(repo.path, 'dirty.txt'), 'utf-8')).toBe('clean\n');
    });

    it('restores from a descendant visible revision (@+) without dirty buffer rebase conflicts', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'desc.txt': 'base line1\nshared line2\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { 'desc.txt': 'current line1\nshared line2\n' },
                isCurrentWorkingCopy: true,
            },
            {
                label: 'descendant',
                parents: ['current'],
                description: 'descendant commit',
                files: { 'desc.txt': 'descendant line1\nshared line2\n' },
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, 'desc.txt'));
        ctx.host.documents.setDocumentText(fileUri, 'unsaved dirty line1\nshared line2\n');

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: '@+' });

        expect(ctx.host.documents.savedUris).toContain(fileUri);
        expect(fs.readFileSync(path.join(repo.path, 'desc.txt'), 'utf-8')).toBe('descendant line1\nshared line2\n');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'restoreFileFrom' });
    });

    it('restores from @ itself to its pre-save committed content when dirty edits are flushed via saveIfDirty', async () => {
        repo.writeFile('self.txt', 'committed wc content\n');
        const fileUri = Uri.file(path.join(repo.path, 'self.txt'));
        ctx.host.documents.setDocumentText(fileUri, 'unsaved dirty buffer\n');

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: '@' });

        expect(ctx.host.documents.savedUris).toContain(fileUri);
        expect(fs.readFileSync(path.join(repo.path, 'self.txt'), 'utf-8')).toBe('committed wc content\n');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'restoreFileFrom' });
    });

    it('shows error when target revision matches multiple revisions or no revisions', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { 'ambiguous.txt': 'v1\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { 'ambiguous.txt': 'v2\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, 'ambiguous.txt'));

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: 'all()' });
        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain(
            'Revision expression "all()" matched multiple revisions; specify a single revision.',
        );

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: 'none()' });
        expect(ctx.host.ui.errorMessages).toHaveLength(2);
        expect(ctx.host.ui.errorMessages[1]).toContain('No revision found for: none()');
        expect(fs.readFileSync(path.join(repo.path, 'ambiguous.txt'), 'utf-8')).toBe('v2\n');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });

    it('rejects out-of-workspace file URIs before prompting or flushing dirty buffers', async () => {
        const outsideRepo = new TestRepo();
        outsideRepo.init();
        try {
            outsideRepo.writeFile('outside.txt', 'external\n');
            const outsideUri = Uri.file(path.join(outsideRepo.path, 'outside.txt'));
            ctx.host.documents.setDocumentText(outsideUri, 'unsaved external draft\n');

            await restoreFileFromRevisionCommand(ctx, { fileUri: outsideUri });

            expect(ctx.host.ui.errorMessages).toHaveLength(1);
            expect(ctx.host.ui.errorMessages[0]).toContain('Selected file is outside the repository workspace.');
            expect(ctx.host.ui.quickPickCalls).toHaveLength(0);
            expect(ctx.host.documents.savedUris).toHaveLength(0);
            expect(mockJjRepo.refresh).not.toHaveBeenCalled();
        } finally {
            await outsideRepo.dispose();
        }
    });

    it('restores valid workspace files whose basename starts with double dots', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: { '..notes.txt': 'v1 dotdot\n' } },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { '..notes.txt': 'v2 dotdot\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const fileUri = Uri.file(path.join(repo.path, '..notes.txt'));

        await restoreFileFromRevisionCommand(ctx, { fileUri, revision: ids.base.changeId });

        expect(fs.readFileSync(path.join(repo.path, '..notes.txt'), 'utf-8')).toBe('v1 dotdot\n');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'restoreFileFrom' });
    });

    it('resolves symlinked workspace alias paths for existing files, deleted files, and root rejection', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'base',
                description: 'base commit',
                files: { 'existing.txt': 'v1 existing\n', 'deleted.txt': 'v1 deleted\n' },
            },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: { 'existing.txt': 'v2 existing\n' },
                isCurrentWorkingCopy: true,
            },
        ]);
        repo.deleteFile('deleted.txt');

        using tempContainer = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-symlink-ws-'));
        const symlinkRoot = path.join(tempContainer.path, 'ws-alias');
        using _wsLink = new ScopedSymlink(symlinkRoot, repo.path, process.platform === 'win32' ? 'junction' : 'dir');

        await restoreFileFromRevisionCommand(ctx, {
            fileUri: Uri.file(path.join(symlinkRoot, 'existing.txt')),
            revision: ids.base.changeId,
        });
        expect(fs.readFileSync(path.join(repo.path, 'existing.txt'), 'utf-8')).toBe('v1 existing\n');

        await restoreFileFromRevisionCommand(ctx, {
            fileUri: Uri.file(path.join(symlinkRoot, 'deleted.txt')),
            revision: ids.base.changeId,
        });
        expect(fs.readFileSync(path.join(repo.path, 'deleted.txt'), 'utf-8')).toBe('v1 deleted\n');

        await restoreFileFromRevisionCommand(ctx, {
            fileUri: Uri.file(symlinkRoot),
            revision: ids.base.changeId,
        });
        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('Cannot restore a directory.');
        expect(mockJjRepo.refresh).toHaveBeenCalledTimes(2);

        fs.mkdirSync(path.join(repo.path, 'subdir'));
        const originalStat = ctx.host.system.fs.stat.bind(ctx.host.system.fs);
        const statCalls: string[] = [];
        vi.spyOn(ctx.host.system.fs, 'stat').mockImplementation(async (targetPath: string) => {
            statCalls.push(targetPath);
            return await originalStat(targetPath);
        });

        await restoreFileFromRevisionCommand(ctx, {
            fileUri: Uri.file(path.join(symlinkRoot, 'subdir')),
            revision: ids.base.changeId,
        });
        expect(statCalls).toHaveLength(1);
        expect(statCalls[0]).toBeSameFsPath(path.join(repo.path, 'subdir'));
        expect(ctx.host.ui.errorMessages).toHaveLength(2);
        expect(ctx.host.ui.errorMessages[1]).toContain('Cannot restore a directory.');
        expect(mockJjRepo.refresh).toHaveBeenCalledTimes(2);
    });

    it('restores files whose names start with a dash or contain fileset metacharacters', async () => {
        const baseFiles: Record<string, string> = {
            '-flag.txt': 'v1 dash\n',
            'file (1).txt': 'v1 paren\n',
        };
        const currentFiles: Record<string, string> = {
            '-flag.txt': 'v2 dash\n',
            'file (1).txt': 'v2 paren\n',
        };
        if (process.platform !== 'win32') {
            baseFiles['a:b.txt'] = 'v1 colon\n';
            currentFiles['a:b.txt'] = 'v2 colon\n';
        }

        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base commit', files: baseFiles },
            {
                label: 'current',
                parents: ['base'],
                description: 'current commit',
                files: currentFiles,
                isCurrentWorkingCopy: true,
            },
        ]);

        await restoreFileFromRevisionCommand(ctx, {
            fileUri: Uri.file(path.join(repo.path, '-flag.txt')),
            revision: ids.base.changeId,
        });
        expect(fs.readFileSync(path.join(repo.path, '-flag.txt'), 'utf-8')).toBe('v1 dash\n');

        await restoreFileFromRevisionCommand(ctx, {
            fileUri: Uri.file(path.join(repo.path, 'file (1).txt')),
            revision: ids.base.changeId,
        });
        expect(fs.readFileSync(path.join(repo.path, 'file (1).txt'), 'utf-8')).toBe('v1 paren\n');

        if (process.platform !== 'win32') {
            await restoreFileFromRevisionCommand(ctx, {
                fileUri: Uri.file(path.join(repo.path, 'a:b.txt')),
                revision: ids.base.changeId,
            });
            expect(fs.readFileSync(path.join(repo.path, 'a:b.txt'), 'utf-8')).toBe('v1 colon\n');
        }

        expect(formatRootFileFileset('a:b.txt')).toBe('root-file:"a:b.txt"');
        expect(formatRootFileFileset('-flag.txt')).toBe('root-file:"-flag.txt"');
        expect(formatRootFileFileset('dir/q"u\\o\t\x1b.txt')).toBe('root-file:"dir/q\\"u\\\\o\\t\\x1b.txt"');
    });

    it('rejects cross-drive Windows paths and stops realpath climbs at backslash drive roots', async () => {
        const realpathCalls: string[] = [];
        const stubFs = createMock<HostFs>({
            realpath: async (target: string) => {
                realpathCalls.push(target);
                if (target === 'D:\\repo') {
                    return 'D:\\repo';
                }
                throw new Error('ENOENT');
            },
        });

        await expect(resolveWorkspaceRelativePath('D:\\repo', 'C:\\', stubFs)).resolves.toBeUndefined();
        await expect(resolveWorkspaceRelativePath('D:\\repo', 'z:\\', stubFs)).resolves.toBeUndefined();
        expect(realpathCalls).not.toContain('/');
        await expect(resolveWorkspaceRelativePath('D:\\repo', 'C:\\')).resolves.toBeUndefined();
        await expect(resolveWorkspaceRelativePath('/repo', '/repo/a:b.txt')).resolves.toBe('a:b.txt');
    });
});
