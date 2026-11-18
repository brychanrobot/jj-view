/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { splitFilesAfterCommand, splitFilesBeforeCommand } from '../../core/commands/split-files';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('split-files commands', () => {
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

    test('splits single file into a new change before target revision and keeps target description', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'base.txt': 'base\n' } },
            {
                label: 'target',
                parents: ['base'],
                description: 'feat: target commit',
                files: { 'a.txt': 'a content\n', 'b.txt': 'b content\n' },
            },
            {
                label: 'child',
                parents: ['target'],
                description: 'child commit',
                files: { 'c.txt': 'c content\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await splitFilesBeforeCommand(ctx, { paths: ['a.txt'], revision: ids.target.changeId });

        const targetParents = repo.getParents(ids.target.changeId);
        expect(targetParents).toHaveLength(1);
        const insertedChangeId = targetParents[0];
        expect(insertedChangeId).not.toBe(ids.base.changeId);

        expect(repo.getParents(insertedChangeId)).toEqual([ids.base.changeId]);
        expect(repo.getParents(ids.child.changeId)).toEqual([ids.target.changeId]);
        expect(repo.getDescription(ids.target.changeId)).toBe('feat: target commit');
        expect(repo.getDescription(insertedChangeId)).toBe('');

        const insertedChanges = await jj.getChanges(insertedChangeId);
        expect(insertedChanges.map((c) => c.path)).toEqual(['a.txt']);
        const targetChanges = await jj.getChanges(ids.target.changeId);
        expect(targetChanges.map((c) => c.path)).toEqual(['b.txt']);
        expect(repo.getFileContent(insertedChangeId, 'a.txt')).toBe('a content\n');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: `after split:${ids.target.changeId}` });
    });

    test('splits multiple files into a new change after target revision and rebases children', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'base.txt': 'base\n' } },
            {
                label: 'target',
                parents: ['base'],
                description: 'feat: multi-file commit',
                files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'keep.txt': 'keep\n' },
            },
            {
                label: 'child',
                parents: ['target'],
                description: 'child commit',
                files: { 'c.txt': 'c\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await splitFilesAfterCommand(ctx, {
            paths: [path.join(repo.path, 'a.txt'), path.join(repo.path, 'b.txt')],
            revision: ids.target.changeId,
        });

        const targetChildren = repo.getChildren(ids.target.changeId);
        expect(targetChildren).toHaveLength(1);
        const insertedChangeId = targetChildren[0];
        expect(insertedChangeId).not.toBe(ids.child.changeId);

        expect(repo.getParents(insertedChangeId)).toEqual([ids.target.changeId]);
        expect(repo.getParents(ids.child.changeId)).toEqual([insertedChangeId]);
        expect(repo.getDescription(ids.target.changeId)).toBe('feat: multi-file commit');
        expect(repo.getDescription(insertedChangeId)).toBe('');

        const insertedChanges = await jj.getChanges(insertedChangeId);
        expect(insertedChanges.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
        const targetChanges = await jj.getChanges(ids.target.changeId);
        expect(targetChanges.map((c) => c.path)).toEqual(['keep.txt']);
    });

    test('splits all files out of a commit leaving original commit empty with description intact', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'base.txt': 'base\n' } },
            {
                label: 'only',
                parents: ['base'],
                description: 'feat: single file commit',
                files: { 'only.txt': 'only content\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await splitFilesBeforeCommand(ctx, { paths: ['only.txt'], revision: '@' });

        const targetParents = repo.getParents('@');
        expect(targetParents).toHaveLength(1);
        const insertedId = targetParents[0];
        expect(insertedId).not.toBe(ids.base.changeId);

        expect(repo.getDescription('@')).toBe('feat: single file commit');
        expect(await jj.getChanges('@')).toEqual([]);
        expect((await jj.getChanges(insertedId)).map((c) => c.path)).toEqual(['only.txt']);
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after split' });
    });

    test('extracts renamed file atomically including oldPath so deletion is not stranded', async () => {
        const longUniqueContent = Array.from({ length: 12 }, (_, idx) => `line ${idx}: unique rename payload`).join(
            '\n',
        );
        const ids = await buildGraph(repo, [
            {
                label: 'base',
                description: 'base',
                files: { 'old-name.txt': longUniqueContent, 'other.txt': 'other v1\n' },
            },
            {
                label: 'target',
                parents: ['base'],
                description: 'refactor: rename and modify',
                isCurrentWorkingCopy: true,
            },
        ]);

        repo.moveFile('old-name.txt', 'new-name.txt');
        repo.writeFile('other.txt', 'other v2\n');

        const initialChanges = await jj.getChanges(ids.target.changeId);
        expect(initialChanges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: 'new-name.txt', status: 'renamed', oldPath: 'old-name.txt' }),
                expect.objectContaining({ path: 'other.txt', status: 'modified' }),
            ]),
        );

        // Select only new-name.txt; split command must include old-name.txt atomically.
        await splitFilesBeforeCommand(ctx, { paths: ['new-name.txt'], revision: ids.target.changeId });

        const [insertedChangeId] = repo.getParents(ids.target.changeId);
        const insertedChanges = await jj.getChanges(insertedChangeId);
        expect(insertedChanges).toEqual([
            expect.objectContaining({ path: 'new-name.txt', status: 'renamed', oldPath: 'old-name.txt' }),
        ]);

        const remainingChanges = await jj.getChanges(ids.target.changeId);
        expect(remainingChanges).toEqual([expect.objectContaining({ path: 'other.txt', status: 'modified' })]);
    });

    test('splits copied file without including its copy source path', async () => {
        const sharedContent = Array.from({ length: 12 }, (_, idx) => `copy line ${idx}: shared body`).join('\n');
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'source.txt': sharedContent } },
            {
                label: 'target',
                parents: ['base'],
                description: 'feat: copy and edit source',
                files: { 'source.txt': `${sharedContent}\nsource edited\n`, 'copy.txt': sharedContent },
                isCurrentWorkingCopy: true,
            },
        ]);

        await splitFilesBeforeCommand(ctx, { paths: ['copy.txt'], revision: ids.target.changeId });

        const [insertedChangeId] = repo.getParents(ids.target.changeId);
        const insertedChanges = await jj.getChanges(insertedChangeId);
        expect(insertedChanges.map((c) => c.path)).toEqual(['copy.txt']);

        const remainingChanges = await jj.getChanges(ids.target.changeId);
        expect(remainingChanges.map((c) => c.path)).toEqual(['source.txt']);
    });

    test('flushes dirty open buffers before splitting working copy revision', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'base.txt': 'base\n' } },
            {
                label: 'wc',
                parents: ['base'],
                description: 'feat: wc changes',
                files: { 'dirty.txt': 'initial disk content\n', 'stay.txt': 'stay\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const dirtyUri = Uri.file(path.join(repo.path, 'dirty.txt'));
        ctx.host.documents.setDocumentText(dirtyUri, 'unsaved buffer content\n');

        await splitFilesBeforeCommand(ctx, { paths: ['dirty.txt'], revision: '@' });

        expect(ctx.host.documents.savedUris.map((u) => u.fsPath)).toContain(dirtyUri.fsPath);
        const [insertedId] = repo.getParents('@');
        expect(repo.getFileContent(insertedId, 'dirty.txt')).toBe('unsaved buffer content\n');
    });

    test('rejects immutable revisions without mutating history', async () => {
        const ids = await buildGraph(repo, [
            { label: 'imm', description: 'immutable commit', files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } },
            { label: 'wc', parents: ['imm'], description: 'wc', isCurrentWorkingCopy: true },
        ]);
        repo.config('revset-aliases."immutable_heads()"', `commit_id("${ids.imm.commitId}")`);

        await splitFilesBeforeCommand(ctx, { paths: ['a.txt'], revision: ids.imm.changeId });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('immutable');
        expect((await jj.getChanges(ids.imm.changeId)).map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
    });

    test('rejects ambiguous multi-revision expressions and paths outside workspace', async () => {
        await buildGraph(repo, [
            { label: 'c1', description: 'c1', files: { 'a.txt': 'a\n' } },
            { label: 'c2', parents: ['c1'], description: 'c2', files: { 'b.txt': 'b\n' }, isCurrentWorkingCopy: true },
        ]);

        await splitFilesBeforeCommand(ctx, { paths: ['a.txt'], revision: 'all()' });
        expect(ctx.host.ui.errorMessages[0]).toContain('matched multiple revisions');

        await splitFilesAfterCommand(ctx, { paths: ['/outside/repo/secret.txt'], revision: '@' });
        expect(ctx.host.ui.errorMessages[1]).toContain('outside the repository workspace');
    });

    test('returns early when paths is empty', async () => {
        await splitFilesBeforeCommand(ctx, { paths: [], revision: '@' });
        await splitFilesAfterCommand(ctx);
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
        expect(ctx.host.ui.errorMessages).toHaveLength(0);
    });

    test('splits a deleted file into a new change before and after', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'del.txt': 'to delete\n', 'keep.txt': 'v1\n' } },
            { label: 'target', parents: ['base'], description: 'feat: delete and edit', isCurrentWorkingCopy: true },
        ]);
        repo.deleteFile('del.txt');
        repo.writeFile('keep.txt', 'v2\n');

        await splitFilesBeforeCommand(ctx, { paths: ['del.txt'], revision: ids.target.changeId });

        const [beforeId] = repo.getParents(ids.target.changeId);
        expect(await jj.getChanges(beforeId)).toEqual([
            expect.objectContaining({ path: 'del.txt', status: 'deleted' }),
        ]);
        expect(await jj.getChanges(ids.target.changeId)).toEqual([
            expect.objectContaining({ path: 'keep.txt', status: 'modified' }),
        ]);

        await splitFilesAfterCommand(ctx, { paths: ['keep.txt'], revision: ids.target.changeId });
        const [afterId] = repo.getChildren(ids.target.changeId);
        expect(await jj.getChanges(afterId)).toEqual([
            expect.objectContaining({ path: 'keep.txt', status: 'modified' }),
        ]);
        expect(await jj.getChanges(ids.target.changeId)).toEqual([]);
    });

    test('splits all files after a commit leaving original empty with description intact', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'base.txt': 'base\n' } },
            {
                label: 'target',
                parents: ['base'],
                description: 'feat: move all files after',
                files: { 'a.txt': 'a\n', 'b.txt': 'b\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await splitFilesAfterCommand(ctx, { paths: ['a.txt', 'b.txt'], revision: ids.target.changeId });

        expect(await jj.getChanges(ids.target.changeId)).toEqual([]);
        expect(repo.getDescription(ids.target.changeId).trim()).toBe('feat: move all files after');

        const [afterId] = repo.getChildren(ids.target.changeId);
        expect((await jj.getChanges(afterId)).map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
        expect(repo.getDescription(afterId).trim()).toBe('');
    });

    test('flushes dirty jj-edit ancestor document and re-resolves evolved commit_id before splitting', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'base.txt': 'base\n' } },
            {
                label: 'target',
                parents: ['base'],
                description: 'feat: ancestor target',
                files: { 'edit-me.txt': 'disk v1\n', 'stay.txt': 'stay\n' },
            },
            { label: 'wc', parents: ['target'], description: 'wc', isCurrentWorkingCopy: true },
        ]);

        const jjEditUri = Uri.from({
            scheme: 'jj-edit',
            path: '/edit-me.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&jj-revision=${ids.target.changeId}&revision=${ids.target.changeId}`,
        });
        ctx.host.documents.openDocumentUris = [jjEditUri];
        const saveSpy = vi.spyOn(ctx.host.documents, 'saveIfDirty').mockImplementation(async (uri) => {
            if (uri.toString() === jjEditUri.toString()) {
                await jj.edit(ids.target.changeId);
                repo.writeFile('edit-me.txt', 'flushed jj-edit v2\n');
                await jj.edit(ids.wc.changeId);
            }
        });

        await splitFilesBeforeCommand(ctx, { paths: ['edit-me.txt'], revision: ids.target.commitId });

        expect(saveSpy).toHaveBeenCalledWith(jjEditUri);
        const [insertedId] = repo.getParents(ids.target.changeId);
        expect(repo.getFileContent(insertedId, 'edit-me.txt')).toBe('flushed jj-edit v2\n');
        expect((await jj.getChanges(ids.target.changeId)).map((c) => c.path)).toEqual(['stay.txt']);
    });

    test('surfaces validationError payload without mutating history', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'a.txt': 'a\n' }, isCurrentWorkingCopy: true },
        ]);

        await splitFilesBeforeCommand(ctx, {
            paths: [],
            revision: '@',
            validationError: 'Cannot split files selected across multiple revisions.',
        });

        expect(ctx.host.ui.errorMessages).toHaveLength(1);
        expect(ctx.host.ui.errorMessages[0]).toContain('multiple revisions');
        expect(mockJjRepo.refresh).not.toHaveBeenCalled();
    });
});
