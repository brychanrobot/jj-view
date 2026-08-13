/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    completeSquashRevisionCommand,
    getSquashStorageDir,
    squashRevisionIntoAncestorCommand,
    squashRevisionIntoParentCommand,
} from '../../commands/squash-revision';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import type { JjLoggerChannel } from '../../utils/output-channel';
import {
    createSquashRevisionIntoAncestorPayload,
    createSquashRevisionIntoParentPayload,
} from '../../vscode/payloads/squash-revision.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { resetMockQuickPick, setActiveItems, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        commands: {
            executeCommand: vi.fn(),
        },
        window: {
            showQuickPick: vi.fn(),
            showTextDocument: vi.fn(),
            showErrorMessage: vi.fn(),
            tabGroups: {
                all: [],
                close: vi.fn(),
            },
        },
        workspace: {
            openTextDocument: vi.fn(),
            textDocuments: [],
        },
        TabInputText: class MockTabInputText {
            constructor(public uri: Uri) {}
        },
    });
});

describe('squashRevisionIntoParentCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;
    let mockQuickPick: vscode.QuickPick<vscode.QuickPickItem>;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({
            jj,
            rootUri: Uri.file(repo.path),
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );

        mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);
        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    const runSquashIntoParent = async (args: unknown[]) => {
        const payload = createSquashRevisionIntoParentPayload(args);
        await squashRevisionIntoParentCommand(ctx, payload);
    };

    const runSquashIntoAncestor = async (args: unknown[]) => {
        const payload = createSquashRevisionIntoAncestorPayload(args);
        await squashRevisionIntoAncestorCommand(ctx, payload);
    };

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

        await runSquashIntoParent([]);

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

        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: p1CommitId,
            label: 'Parent 1',
        });

        await runSquashIntoParent([]);

        expect(vscode.window.showQuickPick).toHaveBeenCalled();

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

        await runSquashIntoParent([]);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.open', expect.anything());

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

        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: p2CommitId,
            label: 'Parent 2',
        });

        await runSquashIntoParent([childChangeId]);

        expect(vscode.window.showQuickPick).toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.open', expect.anything());

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

        await runSquashIntoParent([]);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vscode.open', expect.anything());

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

        await runSquashIntoParent([]);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vscode.open', expect.anything());

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

        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: ids.p1.commitId,
            label: 'Parent 1',
        });

        await runSquashIntoParent([]);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vscode.open', expect.anything());
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

        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
            detail: ids.p2.commitId,
            label: 'Parent 2',
        });

        await runSquashIntoParent([]);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.open', expect.anything());
    });

    test('squashRevisionIntoParentCommand for non-working copy with no descriptions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'p', description: '', files: { 'f.txt': 'p' } },
            { label: 'child', parents: ['p'], description: '', files: { 'f.txt': 'child' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        await runSquashIntoParent([ids.child.changeId]);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vscode.open', expect.anything());
        expect(repo.getDescription(ids.p.changeId)).toBe('');
    });

    test('squashRevisionIntoAncestorCommand picks ancestor and squashes', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', description: 'Base', files: { 'base.txt': 'base' } },
            { label: 'p', parents: ['base'], description: 'Parent', files: { 'p.txt': 'p' } },
            { label: 'child', parents: ['p'], description: '', files: { 'child.txt': 'child' } },
            { label: 'wc', parents: ['child'], isCurrentWorkingCopy: true },
        ]);

        mockQuickPick.value = ids.base.changeId;
        setSelectedItems(mockQuickPick, [{ label: 'base', detail: ids.base.changeId }]);
        setActiveItems(mockQuickPick, [{ label: 'base', detail: ids.base.changeId }]);

        await runSquashIntoAncestor([ids.child.changeId]);

        expect(mockQuickPick.show).toHaveBeenCalled();

        expect(repo.getFileContent(ids.base.changeId, 'child.txt')).toBe('child');
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

        const msgUri = Uri.file(msgPath);
        const mockTab = createMock<vscode.Tab>({
            input: new (class {
                uri = msgUri;
            })(),
        });
        Object.defineProperty(vscode.window.tabGroups, 'all', {
            value: [
                createMock<vscode.TabGroup>({
                    tabs: [mockTab],
                }),
            ],
            configurable: true,
        });

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

        const originalSquash = jj.squashRevision.bind(jj);
        vi.spyOn(jj, 'squashRevision').mockImplementation(async (opts) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return originalSquash(opts);
        });

        const p1 = completeSquashRevisionCommand(ctx, { message: 'm1' });
        const p2 = completeSquashRevisionCommand(ctx, { message: 'm2' });

        await Promise.all([p1, p2]);

        expect(jj.squashRevision).toHaveBeenCalledTimes(1);
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

        const msgUri = Uri.file(msgPath);
        const mockTab = createMock<vscode.Tab>({
            input: new (class {
                uri = msgUri;
            })(),
        });
        Object.defineProperty(vscode.window.tabGroups, 'all', {
            value: [
                createMock<vscode.TabGroup>({
                    tabs: [mockTab],
                }),
            ],
            configurable: true,
        });

        await completeSquashRevisionCommand(ctx, { message: 'JJ: comment only' });

        expect(repo.getDescription('@-')).toBe('Parent');

        expect(fs.existsSync(metaPath)).toBe(false);
        expect(fs.existsSync(msgPath)).toBe(false);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Squash message is empty. Aborting.');
    });

    describe('squash revision payload creators target revision extraction', () => {
        test('createSquashRevisionIntoParentPayload extracts targetParent from object arg', () => {
            const payload = createSquashRevisionIntoParentPayload([{ revision: 'rev1', targetParent: 'parent1' }]);
            expect(payload.revision).toBe('rev1');
            expect(payload.targetParent).toBe('parent1');
        });

        test('createSquashRevisionIntoParentPayload extracts targetParent from multiple revision args', () => {
            const payload = createSquashRevisionIntoParentPayload(['rev1', 'parent1']);
            expect(payload.revision).toBe('rev1');
            expect(payload.targetParent).toBe('parent1');
        });

        test('createSquashRevisionIntoAncestorPayload extracts ancestorRevision from object arg', () => {
            const payload = createSquashRevisionIntoAncestorPayload([{ revision: 'rev1', ancestorRevision: 'anc1' }]);
            expect(payload.revision).toBe('rev1');
            expect(payload.ancestorRevision).toBe('anc1');
        });

        test('createSquashRevisionIntoAncestorPayload extracts ancestorRevision from multiple revision args', () => {
            const payload = createSquashRevisionIntoAncestorPayload(['rev1', 'anc1']);
            expect(payload.revision).toBe('rev1');
            expect(payload.ancestorRevision).toBe('anc1');
        });
    });
});
