/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    completeSquashRevisionCommand,
    getSquashStorageDir,
    squashRevisionIntoAncestorCommand,
    squashRevisionIntoParentCommand,
} from '../../commands/squash-revision';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('squashRevisionIntoParentCommand', () => {
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

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('squashes all changes to parent (implicit)', async () => {
        const fileName = 'file.txt';

        await buildGraph(repo, [
            {
                label: 'root',
                files: { 'root.txt': 'root' },
            },
            {
                label: 'parent',
                parents: ['root'],
                description: 'parent',
                files: { [fileName]: 'parent content', 'other.txt': 'other original' },
            },
            {
                label: 'child',
                parents: ['parent'],
                description: '',
                files: { [fileName]: 'child content', 'other.txt': 'other modified' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await squashRevisionIntoParentCommand(ctx, {});

        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('child content');

        const parentOther = repo.getFileContent('@-', 'other.txt');
        expect(parentOther).toBe('other modified');
    });

    test('handles multiple parents by prompting user', async () => {
        const fileName = 'p1_file.txt';

        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'parent 1', files: { [fileName]: 'p1 content' } },
            { label: 'p2', description: 'parent 2', files: { 'p2_file.txt': 'p2 content' } },
            { parents: ['p1', 'p2'], description: '', files: { [fileName]: 'child modified' } },
        ]);

        const p1ChangeId = ids.p1.changeId;
        const p1CommitId = ids.p1.commitId;

        const parents = repo.getParents('@');
        expect(parents.length).toBe(2);
        expect(parents).toContain(p1ChangeId);

        ctx.host.ui.setNextQuickPickResponse({
            detail: p1CommitId,
            label: 'Parent 1',
            value: p1CommitId,
        });

        await squashRevisionIntoParentCommand(ctx, {});

        const p1Content = repo.getFileContent(p1ChangeId, fileName);
        expect(p1Content).toBe('child modified');
    });

    test('triggers description editor when both have descriptions', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'Parent Description', files: { [fileName]: 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'Child Description',
                files: { [fileName]: 'child content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await squashRevisionIntoParentCommand(ctx, {});

        expect(ctx.host.nav.filesOpened.length).toBeGreaterThan(0);

        const storageDir = getSquashStorageDir(repo.path);
        const metaPath = path.join(storageDir, 'SQUASH_META.json');
        expect(fs.existsSync(metaPath)).toBe(true);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        expect(meta.revision).toBe('@');
    });

    test('handles multiple parents for non-working copy revision', async () => {
        const fileName = 'p1_file.txt';
        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'parent 1', files: { [fileName]: 'p1 content' } },
            { label: 'p2', description: 'parent 2', files: { 'p2_file.txt': 'p2 content' } },
            {
                label: 'child',
                parents: ['p1', 'p2'],
                description: 'Child Description',
                files: { [fileName]: 'child modified' },
            },
            { label: 'tip', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        const childChangeId = ids.child.changeId;
        const p2CommitId = ids.p2.commitId;

        ctx.host.ui.setNextQuickPickResponse({
            detail: p2CommitId,
            label: 'Parent 2',
            value: p2CommitId,
        });

        await squashRevisionIntoParentCommand(ctx, { revision: childChangeId });

        expect(ctx.host.nav.filesOpened.length).toBeGreaterThan(0);

        const storageDir = getSquashStorageDir(repo.path);
        const meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'SQUASH_META.json'), 'utf-8'));
        expect(meta.revision).toBe(childChangeId);
        expect(meta.parentRev).toBe(p2CommitId);
    });

    test('uses child description when parent description is empty', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: '', files: { [fileName]: 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'Child Description',
                files: { [fileName]: 'child content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await squashRevisionIntoParentCommand(ctx, {});

        expect(ctx.host.nav.filesOpened).toHaveLength(0);

        const parentDesc = repo.getDescription('@-');
        expect(parentDesc).toBe('Child Description');
    });

    test('uses parent description when child description is empty', async () => {
        const fileName = 'file.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'Parent Description', files: { [fileName]: 'parent content' } },
            {
                label: 'child',
                parents: ['parent'],
                description: '',
                files: { [fileName]: 'child content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        await squashRevisionIntoParentCommand(ctx, {});

        expect(ctx.host.nav.filesOpened).toHaveLength(0);

        const parentDesc = repo.getDescription('@-');
        expect(parentDesc).toBe('Parent Description');
    });

    test('squashes into empty parent (preserves child desc)', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p1', description: '', files: { 'p1.txt': 'p1' } },
            { label: 'p2', description: 'Parent 2', files: { 'p2.txt': 'p2' } },
            {
                label: 'child',
                parents: ['p1', 'p2'],
                description: 'Child Description',
                files: { 'child.txt': 'child' },
                isCurrentWorkingCopy: true,
            },
        ]);

        ctx.host.ui.setNextQuickPickResponse({
            detail: ids.p1.commitId,
            label: 'Parent 1',
            value: ids.p1.commitId,
        });

        await squashRevisionIntoParentCommand(ctx, {});
        expect(ctx.host.nav.filesOpened).toHaveLength(0);
        expect(repo.getDescription(ids.p1.changeId)).toBe('Child Description');
    });

    test('squashes into non-empty parent (triggers editor)', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p1', description: '', files: { 'p1.txt': 'p1' } },
            { label: 'p2', description: 'Parent 2', files: { 'p2.txt': 'p2' } },
            {
                label: 'child',
                parents: ['p1', 'p2'],
                description: 'Child Description',
                files: { 'child.txt': 'child' },
                isCurrentWorkingCopy: true,
            },
        ]);

        ctx.host.ui.setNextQuickPickResponse({
            detail: ids.p2.commitId,
            label: 'Parent 2',
            value: ids.p2.commitId,
        });

        await squashRevisionIntoParentCommand(ctx, {});
        expect(ctx.host.nav.filesOpened.length).toBeGreaterThan(0);
    });

    test('squashRevisionIntoParentCommand for non-working copy with no descriptions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p', description: '', files: { 'f.txt': 'p' } },
            { label: 'child', parents: ['p'], description: '', files: { 'f.txt': 'child' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        await squashRevisionIntoParentCommand(ctx, { revision: ids.child.changeId });

        expect(ctx.host.nav.filesOpened).toHaveLength(0);
        expect(repo.getDescription(ids.p.changeId)).toBe('');
    });

    test('squashRevisionIntoAncestorCommand picks ancestor and squashes', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'Base', files: { 'base.txt': 'base' } },
            { label: 'p', parents: ['base'], description: 'Parent', files: { 'p.txt': 'p' } },
            { label: 'child', parents: ['p'], description: '', files: { 'child.txt': 'child' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);
        repo.config('revset-aliases."immutable_heads()"', `commit_id("${ids.base.commitId}")`);

        ctx.host.ui.setNextRevisionPromptResponse(ids.p.changeId);

        await squashRevisionIntoAncestorCommand(ctx, { revision: ids.child.changeId });

        expect(repo.getFileContent(ids.p.changeId, 'child.txt')).toBe('child');

        // Verify that prompt only presented mutable ancestors (p), not immutable base or source child
        const quickPick = ctx.host.ui.quickPickCalls[0];
        const details = quickPick.items.map((i) => i.detail);
        expect(details).toContain(ids.p.changeId);
        expect(details).not.toContain(ids.base.changeId);
        expect(details).not.toContain(ids.child.changeId);
    });

    test('completeSquashRevisionCommand completes squash and closes editor', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'Parent' },
            { label: 'child', parents: ['parent'], description: 'Child', isCurrentWorkingCopy: true },
        ]);

        const storageDir = getSquashStorageDir(repo.path);
        fs.mkdirSync(storageDir, { recursive: true });
        const metaPath = path.join(storageDir, 'SQUASH_META.json');
        const msgPath = path.join(storageDir, 'SQUASH_MSG');

        fs.writeFileSync(metaPath, JSON.stringify({ revision: '@', parentRev: ids.parent.commitId }));
        fs.writeFileSync(msgPath, 'New combined description\n\n# Comment');

        await completeSquashRevisionCommand(ctx, { message: 'New combined description' });

        expect(repo.getDescription('@-')).toBe('New combined description');

        expect(fs.existsSync(metaPath)).toBe(false);
        expect(fs.existsSync(msgPath)).toBe(false);
    });

    test('completeSquashRevisionCommand prevents concurrent execution', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'Parent' },
            { label: 'child', parents: ['parent'], description: 'Child', isCurrentWorkingCopy: true },
        ]);

        const storageDir = getSquashStorageDir(repo.path);
        fs.mkdirSync(storageDir, { recursive: true });
        fs.writeFileSync(
            path.join(storageDir, 'SQUASH_META.json'),
            JSON.stringify({ revision: '@', parentRev: ids.parent.commitId }),
        );
        fs.writeFileSync(path.join(storageDir, 'SQUASH_MSG'), 'Desc');

        const p1 = completeSquashRevisionCommand(ctx, { message: 'm1' });
        const p2 = completeSquashRevisionCommand(ctx, { message: 'm2' });

        await Promise.all([p1, p2]);

        expect(repo.getDescription('@-')).toBe('m1');
        expect(fs.existsSync(path.join(storageDir, 'SQUASH_META.json'))).toBe(false);
    });

    test('completeSquashRevisionCommand unlinks files and closes editor when message is empty', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'Parent' },
            { label: 'child', parents: ['parent'], description: 'Child', isCurrentWorkingCopy: true },
        ]);

        const storageDir = getSquashStorageDir(repo.path);
        fs.mkdirSync(storageDir, { recursive: true });
        const metaPath = path.join(storageDir, 'SQUASH_META.json');
        const msgPath = path.join(storageDir, 'SQUASH_MSG');

        fs.writeFileSync(metaPath, JSON.stringify({ revision: '@', parentRev: ids.parent.commitId }));
        fs.writeFileSync(msgPath, 'JJ: comment only');

        await completeSquashRevisionCommand(ctx, { message: 'JJ: comment only' });

        expect(repo.getDescription('@-')).toBe('Parent');

        expect(fs.existsSync(metaPath)).toBe(false);
        expect(fs.existsSync(msgPath)).toBe(false);

        expect(ctx.host.ui.warningMessages).toContain('Squash message is empty. Aborting.');
    });
});
