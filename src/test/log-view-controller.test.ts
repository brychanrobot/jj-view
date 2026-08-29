/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../code-forge-registry';
import { LogViewController } from '../controllers/log-view-controller';
import { JjContextKey } from '../jj-context-keys';
import { JjRepositoryManager } from '../jj-repository-manager';
import type { JjLogEntry } from '../jj-types';
import { Uri } from '../uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('LogViewController Domain Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let controller: LogViewController;
    let postedMessages: unknown[];

    beforeEach(async () => {
        vi.clearAllMocks();
        postedMessages = [];
        testRepo = new TestRepo();
        testRepo.init();

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));
        fakeHost.storage.update('jj-view.hiddenCommitActions', ['squash']);

        repositoryManager = new JjRepositoryManager(registry, outputChannel, fakeHost);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        controller = new LogViewController(repo, fakeHost, {
            messenger: {
                postMessage: (m) => postedMessages.push(m),
            },
        });
    });

    afterEach(async () => {
        controller.dispose();
        await repositoryManager.dispose();
    });

    test('manages commits and fires onDidUpdateCommits', () => {
        const updates: (readonly JjLogEntry[])[] = [];
        controller.onDidUpdateCommits((c) => updates.push(c));

        const dummyCommits: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'test-change-1',
                commit_id: 'test-commit-1',
                description: 'test commit',
                is_immutable: false,
                is_empty: false,
                conflict: false,
                bookmarks: [],
                tags: [],
                parents: [],
            }),
        ];

        controller.setCommits(dummyCommits);
        expect(updates.length).toBe(1);
        expect(controller.commits).toEqual(dummyCommits);
        expect(postedMessages.length).toBeGreaterThan(0);
    });

    test('manages commit selection and guards against identical selections', () => {
        const selections: (readonly string[])[] = [];
        controller.onDidChangeSelection((s) => selections.push(s));

        controller.setSelectedCommits(['c1', 'c2']);
        expect(selections.length).toBe(1);
        expect(controller.selectedCommitIds).toEqual(['c1', 'c2']);

        // Same selection should not fire event
        controller.setSelectedCommits(['c1', 'c2']);
        expect(selections.length).toBe(1);
    });

    test('toggles commit actions and filters invalid action strings', () => {
        expect(controller.hiddenActions).toEqual(['squash']);

        controller.toggleAction('squash');
        expect(controller.hiddenActions).toEqual([]);

        controller.toggleAction('squash');
        expect(controller.hiddenActions).toEqual(['squash']);

        // Invalid action is ignored
        controller.toggleAction('invalidAction');
        expect(controller.hiddenActions).toEqual(['squash']);
    });

    test('updates configuration values and broadcasts update', () => {
        controller.updateConfig({
            theme: 'compact',
            graphLabelAlignment: 'compact',
            minChangeIdLength: 5,
        });

        expect(controller.theme).toBe('compact');
        expect(controller.graphLabelAlignment).toBe('compact');
        expect(controller.minChangeIdLength).toBe(5);
    });

    test('automatically updates configuration when host.config fires onDidChangeConfiguration', () => {
        fakeHost.config.set('logTheme', 'compact');
        fakeHost.config.set('graphLabelAlignment', 'compact');
        fakeHost.config.set('minChangeIdLength', 8);

        expect(controller.theme).toBe('compact');
        expect(controller.graphLabelAlignment).toBe('compact');
        expect(controller.minChangeIdLength).toBe(8);
    });

    test('handles RPC messages via handleMessage', async () => {
        testRepo.writeFile('file.txt', 'hello\n');
        testRepo.describe('initial commit');

        const loadedHandled = await controller.handleMessage({ type: 'webviewLoaded' });
        expect(loadedHandled).toBe(true);

        const selectionHandled = await controller.handleMessage({
            type: 'selectionChange',
            payload: {
                commitIds: ['@'],
                hasImmutableSelection: false,
            },
        });
        expect(selectionHandled).toBe(true);
        expect(controller.selectedCommitIds).toEqual(['@']);
    });

    test('refreshes commits from real repository on disk', async () => {
        testRepo.writeFile('example.txt', 'test content\n');
        testRepo.describe('feature: add example');

        await controller.refresh('test');
        expect(controller.commits.length).toBeGreaterThan(0);
        expect(controller.commits[0].description).toContain('feature: add example');
    });

    test('replays initial snapshot on setMessenger and updates context keys on setCommits', async () => {
        testRepo.writeFile('example.txt', 'test content\n');
        testRepo.describe('feature: add example');
        await controller.refresh('test');

        const newMessages: unknown[] = [];
        controller.setMessenger({
            postMessage: (m) => newMessages.push(m),
        });

        expect(newMessages).toHaveLength(1);
        expect(newMessages[0]).toEqual(
            expect.objectContaining({
                type: 'update',
                payload: expect.objectContaining({
                    commits: expect.any(Array),
                }),
            }),
        );

        // Selection context keys update on setCommits
        const changeId = controller.commits[0].change_id;
        controller.setSelectedCommits([changeId]);
        controller.setCommits(controller.commits);
        expect(fakeHost.commands.contextKeys.get(JjContextKey.SelectionAllowAbandon)).toBe(true);
    });
});
