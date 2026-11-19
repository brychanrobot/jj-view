/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeForgeRegistry } from '../../core/code-forge-registry';
import { disableDiffEditingCommand, enableDiffEditingCommand } from '../../core/commands/toggle-diff-editable';
import { JjEditFsService } from '../../core/jj-edit-fs-service';
import type { JjRepository } from '../../core/jj-repository';
import { JjRepositoryManager } from '../../core/jj-repository-manager';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { JjViewFsService } from '../../core/jj-view-fs-service';
import { createDiffUris, createRevisionUri, decodeJjViewQuery, encodeJjViewQuery, Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

describe('toggleDiffEditable commands', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({ jj });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(async () => {
        await repo.dispose();
        vi.clearAllMocks();
    });

    it('switches mutable ancestor diff from jj-view to jj-edit and closes original diff tab', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'mutable parent', files: { 'notes.txt': 'v1\n' } },
            { label: 'wc', description: 'working copy', parents: ['parent'], files: { 'wc.txt': 'wc\n' } },
        ]);

        const { leftUri, rightUri } = createDiffUris(
            { path: 'notes.txt', status: 'modified' },
            ids.parent.changeId,
            repo.path,
            {
                editable: false,
                workingCopyChangeId: ids.wc.changeId,
            },
        );
        expect(rightUri.scheme).toBe('jj-view');

        let oldTabClosed = false;
        const diffTitle = `notes.txt (${ids.parent.changeId})`;
        ctx.host.documents.openDiffTabs.push({
            originalUri: leftUri,
            modifiedUri: rightUri,
            label: diffTitle,
            close: async () => {
                oldTabClosed = true;
            },
        });

        await enableDiffEditingCommand(ctx, { resourceUri: rightUri });

        expect(ctx.host.nav.diffsOpened).toHaveLength(1);
        const opened = ctx.host.nav.diffsOpened[0];
        expect(opened.leftUri.toString()).toBe(leftUri.toString());
        expect(opened.rightUri.scheme).toBe('jj-edit');
        expect(opened.rightUri.path).toBe(Uri.file(path.resolve(repo.path, 'notes.txt')).path);
        expect(opened.rightUri.path).toBe(opened.leftUri.path);
        expect(opened.rightUri.fragment).toContain(`jj-revision=${ids.parent.changeId}`);
        expect(opened.rightUri.fragment).toContain(`revision=${ids.parent.changeId}`);
        expect(opened.title).toBe(diffTitle);
        expect(opened.options).toEqual({ preview: false });
        expect(oldTabClosed).toBe(true);
        expect(ctx.host.nav.closedTabs).toHaveLength(0);
    });

    it('flushes dirty edits via JjEditFsService and switches diff back to fresh read-only jj-view', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'mutable parent', files: { 'notes.txt': 'initial parent content\n' } },
            { label: 'wc', description: 'working copy', parents: ['parent'], files: { 'wc.txt': 'wc\n' } },
        ]);

        const host = ctx.host;
        host.workspace.addFolder(Uri.file(repo.path));
        const outputChannel = createMockLogOutputChannel({ appendLine: () => {} });
        const repoManager = new JjRepositoryManager(new CodeForgeRegistry(), outputChannel, host);
        const registeredRepo = await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        expect(registeredRepo).toBeDefined();
        if (!registeredRepo) {
            return;
        }

        const viewFs = new JjViewFsService(repoManager);
        const editFs = new JjEditFsService(repoManager, () => {
            viewFs.invalidateCache();
        });
        const realCtx = new FakeCommandContext(registeredRepo, host);

        try {
            const readOnly = createDiffUris({ path: 'notes.txt', status: 'modified' }, ids.parent.changeId, repo.path, {
                editable: false,
                workingCopyChangeId: ids.wc.changeId,
            });
            const editable = createDiffUris({ path: 'notes.txt', status: 'modified' }, ids.parent.changeId, repo.path, {
                editable: true,
                workingCopyChangeId: ids.wc.changeId,
            });

            // Warm JjViewFsService diff cache before toggling to editable to verify invalidation works
            const cachedBefore = Buffer.from(await viewFs.readFile(readOnly.rightUri)).toString('utf8');
            expect(cachedBefore).toBe('initial parent content\n');

            const pendingText = 'updated via jj-edit before locking\n';
            const origSaveIfDirty = host.documents.saveIfDirty.bind(host.documents);
            host.documents.saveIfDirty = async (uri: Uri): Promise<void> => {
                await origSaveIfDirty(uri);
                await editFs.writeFile(uri, new TextEncoder().encode(pendingText));
            };

            let editTabClosed = false;
            const diffTitle = `notes.txt (${ids.parent.changeId})`;
            host.documents.openDiffTabs.push({
                originalUri: editable.leftUri,
                modifiedUri: editable.rightUri,
                label: diffTitle,
                close: async () => {
                    editTabClosed = true;
                },
            });

            await disableDiffEditingCommand(realCtx, { resourceUri: editable.rightUri });

            expect(host.documents.savedUris.map((u) => u.toString())).toEqual([editable.rightUri.toString()]);
            expect(repo.getFileContent(ids.parent.changeId, 'notes.txt')).toBe(pendingText);
            expect(host.nav.diffsOpened).toHaveLength(1);

            const reopened = host.nav.diffsOpened[0];
            expect(reopened.leftUri.toString()).toBe(editable.leftUri.toString());
            expect(reopened.rightUri.scheme).toBe('jj-view');
            expect(reopened.rightUri.fragment).toContain('side=right');
            expect(reopened.title).toBe(diffTitle);
            expect(reopened.options).toEqual({ preview: false });
            expect(editTabClosed).toBe(true);

            // Re-reading the jj-view URI must reflect the newly saved content, not stale cache
            const freshRead = Buffer.from(await viewFs.readFile(reopened.rightUri)).toString('utf8');
            expect(freshRead).toBe(pendingText);
        } finally {
            viewFs.dispose();
            editFs.dispose();
            await repoManager.dispose();
        }
    });

    it('toggles standalone revision file tabs between jj-view and jj-edit', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'mutable parent', files: { 'solo.txt': 'solo\n' } },
            { label: 'wc', description: 'working copy', parents: ['parent'] },
        ]);

        const viewUri = createRevisionUri(repo.path, 'solo.txt', ids.parent.changeId);
        await enableDiffEditingCommand(ctx, { resourceUri: viewUri });

        expect(ctx.host.nav.filesOpened).toHaveLength(1);
        const editUri = ctx.host.nav.filesOpened[0];
        expect(editUri.scheme).toBe('jj-edit');
        expect(editUri.path).toBe(Uri.file(path.resolve(repo.path, 'solo.txt')).path);
        expect(ctx.host.nav.closedTabs.map((u) => u.toString())).toEqual([viewUri.toString()]);

        await disableDiffEditingCommand(ctx, { resourceUri: editUri });

        expect(ctx.host.documents.savedUris.map((u) => u.toString())).toEqual([editUri.toString()]);
        expect(ctx.host.nav.filesOpened).toHaveLength(2);
        const reopenedView = ctx.host.nav.filesOpened[1];
        expect(reopenedView.scheme).toBe('jj-view');
        expect(decodeJjViewQuery(reopenedView)).toEqual({
            mode: 'revision',
            root: repo.path,
            revision: ids.parent.changeId,
        });
        expect(ctx.host.nav.closedTabs.map((u) => u.toString())).toEqual([viewUri.toString(), editUri.toString()]);
    });

    it('guards deleted files in mutable commits without replacing the diff tab', async () => {
        repo.writeFile('deleted.txt', 'doomed\n');
        repo.describe('base commit');
        repo.new();
        repo.deleteFile('deleted.txt');
        repo.describe('delete file');
        const parentChangeId = repo.getChangeId('@');
        repo.new();
        const wcChangeId = repo.getChangeId('@');

        const { leftUri, rightUri } = createDiffUris(
            { path: 'deleted.txt', status: 'deleted' },
            parentChangeId,
            repo.path,
            { editable: true, workingCopyChangeId: wcChangeId },
        );
        expect(rightUri.scheme).toBe('jj-view');

        let oldTabClosed = false;
        ctx.host.documents.openDiffTabs.push({
            originalUri: leftUri,
            modifiedUri: rightUri,
            label: `deleted.txt (${parentChangeId})`,
            close: async () => {
                oldTabClosed = true;
            },
        });

        await enableDiffEditingCommand(ctx, { resourceUri: rightUri });

        expect(ctx.host.ui.infoMessages).toContain('Cannot edit a deleted file.');
        expect(ctx.host.nav.diffsOpened).toHaveLength(0);
        expect(ctx.host.nav.closedTabs).toHaveLength(0);
        expect(oldTabClosed).toBe(false);
    });

    it('rejects immutable revisions with warning and does not open jj-edit', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'immutable base', files: { 'base.txt': 'base\n' } },
            { label: 'wc', description: 'working copy', parents: ['base'] },
        ]);
        repo.config('revset-aliases."immutable_heads()"', `commit_id("${ids.base.commitId}")`);

        const { rightUri } = createDiffUris({ path: 'base.txt', status: 'modified' }, ids.base.changeId, repo.path, {
            editable: false,
            workingCopyChangeId: ids.wc.changeId,
        });

        await enableDiffEditingCommand(ctx, { resourceUri: rightUri });

        expect(ctx.host.ui.warningMessages).toContain('Cannot edit file: revision is immutable.');
        expect(ctx.host.nav.diffsOpened).toHaveLength(0);
        expect(ctx.host.nav.filesOpened).toHaveLength(0);
    });

    it('guards side=left, left pane of open diff, revision=none, uploaded mode, and file:// URIs', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'mutable parent', files: { 'a.txt': 'a\n' } },
            { label: 'wc', description: 'working copy', parents: ['parent'] },
        ]);

        const { leftUri, rightUri } = createDiffUris(
            { path: 'a.txt', status: 'modified' },
            ids.parent.changeId,
            repo.path,
            {
                editable: false,
                workingCopyChangeId: ids.wc.changeId,
            },
        );

        // Standalone side=left
        await enableDiffEditingCommand(ctx, { resourceUri: leftUri });
        expect(ctx.host.ui.infoMessages.length).toBe(1);

        // Uploaded preview mode
        const uploadedUri = Uri.from({
            scheme: 'jj-view',
            path: '/a.txt',
            fragment: encodeJjViewQuery({ mode: 'uploaded', root: repo.path, changeId: ids.parent.changeId }),
        });
        await enableDiffEditingCommand(ctx, { resourceUri: uploadedUri });
        expect(ctx.host.ui.infoMessages.length).toBe(2);

        // revision=none
        const noneUri = createRevisionUri(repo.path, 'a.txt', 'none');
        await enableDiffEditingCommand(ctx, { resourceUri: noneUri });
        expect(ctx.host.ui.infoMessages.length).toBe(3);

        // Original (left) pane of open diff tab
        ctx.host.documents.openDiffTabs.push({
            originalUri: createRevisionUri(repo.path, 'a.txt', ids.parent.changeId),
            modifiedUri: rightUri,
            close: async () => {},
        });
        await enableDiffEditingCommand(ctx, {
            resourceUri: createRevisionUri(repo.path, 'a.txt', ids.parent.changeId),
        });
        expect(ctx.host.ui.infoMessages.length).toBe(4);

        // Non-jj scheme is a clean no-op
        await enableDiffEditingCommand(ctx, { resourceUri: Uri.file(`${repo.path}/a.txt`) });
        await disableDiffEditingCommand(ctx, { resourceUri: Uri.file(`${repo.path}/a.txt`) });

        expect(ctx.host.nav.diffsOpened).toHaveLength(0);
        expect(ctx.host.nav.filesOpened).toHaveLength(0);
    });

    it('falls back to active document URI when payload is omitted (Command Palette)', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'mutable parent', files: { 'cmd.txt': 'v1\n' } },
            { label: 'wc', description: 'working copy', parents: ['parent'] },
        ]);
        const { leftUri, rightUri } = createDiffUris(
            { path: 'cmd.txt', status: 'modified' },
            ids.parent.changeId,
            repo.path,
            {
                editable: false,
                workingCopyChangeId: ids.wc.changeId,
            },
        );
        ctx.host.documents.openDiffTabs.push({
            originalUri: leftUri,
            modifiedUri: rightUri,
            label: `cmd.txt (${ids.parent.changeId})`,
            close: async () => {},
        });
        ctx.host.documents.setActiveDocument(rightUri);

        await enableDiffEditingCommand(ctx);

        expect(ctx.host.nav.diffsOpened).toHaveLength(1);
        const editUri = ctx.host.nav.diffsOpened[0].rightUri;
        expect(editUri.scheme).toBe('jj-edit');

        ctx.host.documents.openDiffTabs.push({
            originalUri: leftUri,
            modifiedUri: editUri,
            label: `cmd.txt (${ids.parent.changeId})`,
            close: async () => {},
        });
        ctx.host.documents.setActiveDocument(editUri);

        await disableDiffEditingCommand(ctx);

        expect(ctx.host.nav.diffsOpened).toHaveLength(2);
        expect(ctx.host.nav.diffsOpened[1].rightUri.scheme).toBe('jj-view');
    });
});
