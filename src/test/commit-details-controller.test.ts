/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { CommitDetailsController } from '../core/controllers/commit-details-controller';
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../core/host/ipc/commit-details-schemas';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMockWebviewClient, type MockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('CommitDetailsController Domain Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let controller: CommitDetailsController;
    let client: MockWebviewClient<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage>;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        repositoryManager = new JjRepositoryManager(registry, outputChannel, fakeHost);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        client = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });

        controller = new CommitDetailsController('@', repo, fakeHost);
        controller.addMessenger(client.webview);
    });

    afterEach(async () => {
        client.dispose();
        controller.dispose();
        await repositoryManager.dispose();
        testRepo.dispose();
    });

    test('loads commit details and changes from real repository', async () => {
        testRepo.writeFile('file.txt', 'hello world\n');
        testRepo.describe('initial commit description');

        const log = await controller.load();

        expect(log).toBeDefined();
        expect(controller.logEntry).toBeDefined();
        expect(controller.logEntry?.description).toContain('initial commit description');
        expect(controller.changes?.length).toBeGreaterThan(0);
    });

    test('preserves draft description when reloading commit data', async () => {
        testRepo.writeFile('file.txt', 'hello\n');
        testRepo.describe('persisted description');

        await controller.load();
        expect(controller.draftDescription).toBe('persisted description');

        // User types a draft
        controller.updateDraft('in-progress draft editing');
        expect(controller.draftDescription).toBe('in-progress draft editing');

        // Background reload happens
        await controller.load();
        expect(controller.draftDescription).toBe('in-progress draft editing');
        expect(controller.persistedDescription).toBe('persisted description');
        expect(controller.getState()?.description).toBe('persisted description');
    });

    test('saves commit description to real repository', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('old description');

        await controller.load();
        const saved = await controller.save('new updated description');

        expect(saved).toBe(true);
        expect(controller.draftDescription).toBe('new updated description');
        expect(controller.persistedDescription).toBe('new updated description');

        // Verify with real log on disk
        const log = testRepo.log();
        expect(log).toContain('new updated description');
    });

    test('handles descriptionChanged RPC message', async () => {
        const handled = await controller.handleMessage({
            type: 'descriptionChanged',
            payload: {
                description: 'typed from webview',
                selectionStart: 5,
                selectionEnd: 5,
            },
        });

        expect(handled).toBe(true);
        expect(controller.draftDescription).toBe('typed from webview');
    });

    test('replays initial state snapshot to newly attached messenger after load', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial commit for replay');

        await controller.load();

        const lateClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        controller.addMessenger(lateClient.webview);
        await Promise.resolve();

        expect(lateClient.receivedMessages).toHaveLength(1);
        expect(lateClient.receivedMessages[0]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                description: 'initial commit for replay',
            }),
        });

        lateClient.dispose();
    });

    test('fires onDidClose only when the last messenger detaches', async () => {
        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }
        const testController = new CommitDetailsController('@', repo, fakeHost);
        const closeListener = vi.fn();
        testController.onDidClose(closeListener);

        const client1 = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        const client2 = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });

        const sub1 = testController.addMessenger(client1.webview);
        const sub2 = testController.addMessenger(client2.webview);

        // Disposing first messenger does not fire onDidClose because client2 is still attached
        sub1.dispose();
        expect(closeListener).not.toHaveBeenCalled();

        // Disposing second messenger fires onDidClose
        sub2.dispose();
        expect(closeListener).toHaveBeenCalledTimes(1);

        client1.dispose();
        client2.dispose();
        testController.dispose();
    });

    test('loads commit details for a conflicted commit', async () => {
        testRepo.writeFile('file.txt', 'base content\n');
        testRepo.describe('base');

        testRepo.new(['@'], 'side 1');
        testRepo.writeFile('file.txt', 'side 1 content\n');

        testRepo.new(['@-'], 'side 2');
        testRepo.writeFile('file.txt', 'side 2 content\n');

        testRepo.new(['@-+', '@'], 'merge with conflict');

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }
        const conflictController = new CommitDetailsController('@', repo, fakeHost);
        const conflictClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        conflictController.addMessenger(conflictClient.webview);

        const log = await conflictController.load();
        expect(log).toBeDefined();
        expect(conflictController.logEntry?.conflict).toBe(true);

        const state = conflictController.getState();
        expect(state).toBeDefined();
        expect(state?.isConflict).toBe(true);
        expect(state?.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: 'file.txt',
                    conflicted: true,
                    conflictSides: 2,
                }),
            ]),
        );

        const updates = conflictClient.receivedMessages.filter((m) => m.type === 'update');
        expect(updates.length).toBeGreaterThanOrEqual(2);
        expect(updates[0]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                isConflict: true,
                isLoadingFiles: true,
            }),
        });
        expect(updates[updates.length - 1]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                isConflict: true,
                isLoadingFiles: false,
                files: expect.arrayContaining([
                    expect.objectContaining({
                        path: 'file.txt',
                        conflicted: true,
                        conflictSides: 2,
                    }),
                ]),
            }),
        });

        conflictClient.dispose();
        conflictController.dispose();
    });

    test('loads commit details for a divergent commit', async () => {
        testRepo.writeFile('file.txt', 'v1\n');
        testRepo.describe('feature v1');
        const changeId = testRepo.getChangeId('@');
        const commitIdV1 = testRepo.getCommitId('@');

        testRepo.describe('feature v2', changeId);
        testRepo.bookmark('old-version', commitIdV1);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }

        const logs = await repo.jj.getLog({ revision: 'all()' });
        const divergentEntry = logs.find((l) => l.is_divergent);
        expect(divergentEntry).toBeDefined();
        if (!divergentEntry) {
            throw new Error('divergentEntry not found');
        }
        expect(divergentEntry.change_id).toContain('/');

        const divergentController = new CommitDetailsController(divergentEntry.change_id, repo, fakeHost);
        const log = await divergentController.load();
        expect(log).toBeDefined();
        expect(divergentController.logEntry?.change_id).toBe(divergentEntry.change_id);
        expect(divergentController.getState()?.changeId).toBe(divergentEntry.change_id);

        divergentController.dispose();
    });

    test('two-stage loading emits metadata immediately from cache before diff stats complete', async () => {
        testRepo.writeFile('big-file.txt', 'a'.repeat(1000));
        testRepo.describe('fast metadata commit');
        const changeId = testRepo.getChangeId('@');

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('repo not found');
        }

        // 1. Simulate LogView fetching the log slice (which populates _logEntryCache in JjService)
        await repo.jj.getLog({ omitChanges: true, includeNearestVisibleAncestors: true });

        // 2. Open commit details with controller
        const detailsController = new CommitDetailsController(changeId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        const loadPromise = detailsController.load();

        // 3. Wait for load to complete
        await loadPromise;

        const updates = detailsClient.receivedMessages.filter((m) => m.type === 'update');
        expect(updates.length).toBe(2);

        // First update: metadata available immediately, files loading
        expect(updates[0]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                changeId,
                description: 'fast metadata commit',
                isLoadingFiles: true,
                files: [],
            }),
        });

        // Second update: diff calculation finished, files populated
        expect(updates[1]).toEqual({
            type: 'update',
            payload: expect.objectContaining({
                changeId,
                description: 'fast metadata commit',
                isLoadingFiles: false,
                files: expect.arrayContaining([
                    expect.objectContaining({
                        path: 'big-file.txt',
                        status: 'added',
                    }),
                ]),
            }),
        });

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('getInitialPayload preserves active dirty drafts and returns initial state', async () => {
        testRepo.writeFile('initial.txt', 'initial');
        testRepo.describe('persisted description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        detailsController.updateDraft('unsaved dirty description');

        const payload = await detailsController.getInitialPayload();
        expect(payload).toBeDefined();
        expect(payload?.changeId).toBe(commitId);
        expect(detailsController.draftDescription).toBe('unsaved dirty description');
        expect(payload?.isLoadingFiles).toBe(true);

        detailsController.dispose();
    });

    test('revert dispatches both update and updateDescription messages to reset webview state', async () => {
        testRepo.writeFile('initial.txt', 'initial');
        testRepo.describe('persisted description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        await detailsController.load();
        detailsController.updateDraft('unsaved user edits');
        expect(detailsController.draftDescription).toBe('unsaved user edits');

        detailsController.revert();
        expect(detailsController.draftDescription).toBe('persisted description');

        await new Promise((resolve) => setTimeout(resolve, 10));

        const updateDescMessage = detailsClient.receivedMessages.find((m) => m.type === 'updateDescription');
        expect(updateDescMessage).toEqual({
            type: 'updateDescription',
            payload: {
                description: 'persisted description',
                selectionStart: 0,
                selectionEnd: 0,
            },
        });

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('preserves in-flight edits typed while save is actively executing', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        await detailsController.load();
        detailsController.updateDraft('version 2 to save');

        // Start save
        const savePromise = detailsController.save();

        // While save is in flight, user types more
        detailsController.updateDraft('version 2 to save + concurrent edits');

        const saved = await savePromise;
        expect(saved).toBe(true);

        // Draft must NOT be purged!
        expect(detailsController.draftDescription).toBe('version 2 to save + concurrent edits');
        expect(detailsController.persistedDescription).toBe('version 2 to save');

        // Verify saveComplete message sent to webview has savedDraft
        const saveCompleteMsg = detailsClient.receivedMessages.find((m) => m.type === 'saveComplete');
        expect(saveCompleteMsg).toEqual({
            type: 'saveComplete',
            payload: {
                description: 'version 2 to save',
                savedDraft: 'version 2 to save',
            },
        });

        // Repository on disk has 'version 2 to save'
        expect(testRepo.log()).toContain('version 2 to save');

        // A second save now persists the remaining in-flight edits
        const secondSave = await detailsController.save();
        expect(secondSave).toBe(true);
        expect(detailsController.draftDescription).toBe('version 2 to save + concurrent edits');
        expect(detailsController.persistedDescription).toBe('version 2 to save + concurrent edits');
        expect(testRepo.log()).toContain('version 2 to save + concurrent edits');

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('coalesces concurrent save calls and saves latest draft sequentially', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        await detailsController.load();

        detailsController.updateDraft('draft 1');
        const save1 = detailsController.save();

        detailsController.updateDraft('draft 2');
        const save2 = detailsController.save();

        detailsController.updateDraft('draft 3');
        const save3 = detailsController.save();

        const results = await Promise.all([save1, save2, save3]);
        expect(results).toEqual([true, true, true]);

        expect(detailsController.draftDescription).toBe('draft 3');
        expect(detailsController.persistedDescription).toBe('draft 3');
        expect(testRepo.log()).toContain('draft 3');

        detailsController.dispose();
    });

    test('records edit on host when in-flight edits are present upon save completion', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const editRecordedListener = vi.fn();
        const detailsController = new CommitDetailsController(commitId, repo, fakeHost, {
            onEditRecorded: editRecordedListener,
        });

        await detailsController.load();
        detailsController.updateDraft('first draft to save');

        const savePromise = detailsController.save();
        detailsController.updateDraft('first draft to save + more typing');

        await savePromise;

        // Allow microtask to fire
        await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
        });

        expect(editRecordedListener).toHaveBeenCalled();
        const lastCall = editRecordedListener.mock.calls[editRecordedListener.mock.calls.length - 1];
        expect(lastCall[0]).toEqual(
            expect.objectContaining({
                label: 'Edit Description',
            }),
        );

        detailsController.dispose();
    });
});
