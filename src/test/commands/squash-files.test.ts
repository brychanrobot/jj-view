/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    squashFilesIntoAncestorCommand,
    squashFilesIntoChildCommand,
    squashFilesIntoParentCommand,
} from '../../commands/squash-files';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import type { JjLoggerChannel } from '../../utils/output-channel';
import {
    createSquashFilesIntoAncestorPayload,
    createSquashFilesIntoChildPayload,
    createSquashFilesIntoParentPayload,
} from '../../vscode/payloads/squash-files.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';
import { resetMockQuickPick, setActiveItems, setSelectedItems } from '../vitest-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        window: {
            showErrorMessage: vi.fn(),
        },
    });
});

describe('squash-files commands', () => {
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

    const runSquashFilesIntoParent = async (args: unknown[]) => {
        const payload = createSquashFilesIntoParentPayload(args);
        await squashFilesIntoParentCommand(ctx, payload);
    };

    const runSquashFilesIntoAncestor = async (args: unknown[]) => {
        const payload = createSquashFilesIntoAncestorPayload(args);
        await squashFilesIntoAncestorCommand(ctx, payload);
    };

    const runSquashFilesIntoChild = async (args: unknown[]) => {
        const payload = createSquashFilesIntoChildPayload(args);
        await squashFilesIntoChildCommand(ctx, payload);
    };

    describe('squashFilesIntoParentCommand', () => {
        test('squashes specific file to parent', async () => {
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
                    description: 'child',
                    files: { [fileName]: 'child content', 'other.txt': 'other modified' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            const fileUri = Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }];

            await runSquashFilesIntoParent(args);

            const parentContent = repo.getFileContent('@-', fileName);
            expect(parentContent).toBe('child content');

            const parentOther = repo.getFileContent('@-', 'other.txt');
            expect(parentOther).toBe('other original');
        });
    });

    describe('squashFilesIntoAncestorCommand', () => {
        test('squashes specific file into grandparent', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                { label: 'grandparent', description: 'grandparent', files: { [fileName]: 'grandparent content' } },
                {
                    label: 'parent',
                    parents: ['grandparent'],
                    description: 'parent',
                    files: { 'parent_file.txt': 'parent content' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                    files: { [fileName]: 'child content', 'other.txt': 'other content' },
                    isCurrentWorkingCopy: true,
                },
            ]);

            mockQuickPick.value = ids.grandparent.changeId;
            setSelectedItems(mockQuickPick, [{ label: 'grandparent', detail: ids.grandparent.changeId }]);
            setActiveItems(mockQuickPick, [{ label: 'grandparent', detail: ids.grandparent.changeId }]);

            const fileUri = Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }];

            await runSquashFilesIntoAncestor(args);

            expect(mockQuickPick.show).toHaveBeenCalled();

            const gpContent = repo.getFileContent(ids.grandparent.changeId, fileName);
            expect(gpContent).toBe('child content');

            const childOtherContent = repo.getFileContent('@', 'other.txt');
            expect(childOtherContent).toBe('other content');
        });
    });

    describe('squashFilesIntoChildCommand', () => {
        test('squashes file to single child', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'parent modified' },
                },
                {
                    label: 'child',
                    parents: ['parent'],
                    description: 'child',
                },
            ]);

            const fileUri = Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }, { revision: ids.parent.changeId }];

            await runSquashFilesIntoChild(args);

            expect(repo.getFileContent(ids.child.changeId, fileName)).toBe('parent modified');
        });

        test('prompts when multiple children exist', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [
                {
                    label: 'parent',
                    description: 'parent',
                    files: { [fileName]: 'parent modified' },
                },
                { label: 'child1', parents: ['parent'] },
                { label: 'child2', parents: ['parent'] },
            ]);

            mockQuickPick.value = ids.child2.changeId;
            setSelectedItems(mockQuickPick, [{ label: 'child2', detail: ids.child2.changeId }]);
            setActiveItems(mockQuickPick, [{ label: 'child2', detail: ids.child2.changeId }]);

            const fileUri = Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }, { revision: ids.parent.changeId }];

            await runSquashFilesIntoChild(args);

            expect(mockQuickPick.show).toHaveBeenCalled();
            expect(repo.getFileContent(ids.child2.changeId, fileName)).toBe('parent modified');
        });

        test('shows error when no children exist', async () => {
            const fileName = 'file.txt';
            const ids = await buildGraph(repo, [{ label: 'only', description: 'only', files: { [fileName]: 'mod' } }]);

            const fileUri = Uri.file(path.join(repo.path, fileName));
            const args = [{ resourceUri: fileUri }, { revision: ids.only.changeId }];

            await runSquashFilesIntoChild(args);
        });
    });

    describe('payload creators target revision extraction', () => {
        test('createSquashFilesIntoAncestorPayload extracts ancestorRevision from object arg', () => {
            const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
            const payload = createSquashFilesIntoAncestorPayload([
                { resourceUri: fileUri },
                { revision: 'srcRev', ancestorRevision: 'targetAncestor' },
            ]);
            expect(payload.revision).toBe('srcRev');
            expect(payload.ancestorRevision).toBe('targetAncestor');
        });

        test('createSquashFilesIntoAncestorPayload extracts ancestorRevision from multiple revision args', () => {
            const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
            const payload = createSquashFilesIntoAncestorPayload([
                { resourceUri: fileUri },
                'srcRev',
                'targetAncestor',
            ]);
            expect(payload.revision).toBe('srcRev');
            expect(payload.ancestorRevision).toBe('targetAncestor');
        });

        test('createSquashFilesIntoChildPayload extracts childRevision from object arg', () => {
            const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
            const payload = createSquashFilesIntoChildPayload([
                { resourceUri: fileUri },
                { revision: 'srcRev', childRevision: 'targetChild' },
            ]);
            expect(payload.revision).toBe('srcRev');
            expect(payload.childRevision).toBe('targetChild');
        });

        test('createSquashFilesIntoChildPayload extracts childRevision from multiple revision args', () => {
            const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
            const payload = createSquashFilesIntoChildPayload([{ resourceUri: fileUri }, 'srcRev', 'targetChild']);
            expect(payload.revision).toBe('srcRev');
            expect(payload.childRevision).toBe('targetChild');
        });
    });
});
