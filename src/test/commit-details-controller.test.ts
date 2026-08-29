/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../code-forge-registry';
import { CommitDetailsController } from '../controllers/commit-details-controller';
import { JjRepositoryManager } from '../jj-repository-manager';
import { Uri } from '../uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('CommitDetailsController Domain Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let controller: CommitDetailsController;
    let postedMessages: unknown[];

    beforeEach(async () => {
        vi.clearAllMocks();
        postedMessages = [];
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

        controller = new CommitDetailsController('@', repo, fakeHost);
        controller.addMessenger({
            postMessage: (m) => postedMessages.push(m),
        });
    });

    afterEach(async () => {
        controller.dispose();
        await repositoryManager.dispose();
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

        const lateMessages: unknown[] = [];
        controller.addMessenger({
            postMessage: (m) => lateMessages.push(m),
        });

        expect(lateMessages).toHaveLength(1);
        expect(lateMessages[0]).toEqual(
            expect.objectContaining({
                type: 'update',
                payload: expect.objectContaining({
                    description: 'initial commit for replay',
                }),
            }),
        );
    });

    test('fires onDidClose only when the last messenger detaches', async () => {
        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        const testController = new CommitDetailsController('@', repo, fakeHost);
        const closeListener = vi.fn();
        testController.onDidClose(closeListener);

        const messenger1 = { postMessage: vi.fn() };
        const messenger2 = { postMessage: vi.fn() };

        const sub1 = testController.addMessenger(messenger1);
        const sub2 = testController.addMessenger(messenger2);

        // Disposing first messenger does not fire onDidClose because messenger2 is still attached
        sub1.dispose();
        expect(closeListener).not.toHaveBeenCalled();

        // Disposing second messenger fires onDidClose
        sub2.dispose();
        expect(closeListener).toHaveBeenCalledTimes(1);

        testController.dispose();
    });
});
