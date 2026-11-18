/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import type { CodeForgeProvider } from '../core/code-forge-provider';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { MANUAL_REFRESH_REASON } from '../core/code-forge-service';
import { LogViewController } from '../core/controllers/log-view-controller';
import { EventEmitter } from '../core/host/events';
import type { HostWatcher, ProcessExecOptions, ProcessResult } from '../core/host/host-system';
import { NodeHostFs, NodeHostProcess, NodeHostSystem } from '../core/host/node-host-system';
import { JjContextKey } from '../core/jj-context-keys';
import { JjRepository } from '../core/jj-repository';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import type { JjLogEntry } from '../core/jj-types';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('LogViewController Domain Unit Tests', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let registry: CodeForgeRegistry;
    let controller: LogViewController;
    let postedMessages: unknown[];

    beforeEach(async () => {
        vi.clearAllMocks();
        postedMessages = [];
        testRepo = new TestRepo();
        testRepo.init();

        registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        fakeHost = new FakeHostEnvironment(
            new NodeHostSystem({
                watcher: {
                    watch: async () => ({
                        unsubscribe: async () => {},
                    }),
                },
            }),
        );
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));
        fakeHost.storage.update('jj-view.hiddenCommitActions', ['squash']);

        repositoryManager = new JjRepositoryManager(registry, outputChannel, fakeHost);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }
        await repo.watcher.dispose();
        await repo.activeRefresh;

        controller = new LogViewController(repo, fakeHost, {
            messenger: {
                postMessage: (m) => postedMessages.push(m),
            },
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        controller?.dispose();
        await repositoryManager?.dispose();
        await testRepo?.dispose();
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

        postedMessages.length = 0;
        const selectionHandled = await controller.handleMessage({
            type: 'selectionChange',
            payload: {
                commitIds: ['@'],
                hasImmutableSelection: false,
            },
        });
        expect(selectionHandled).toBe(true);
        expect(controller.selectedCommitIds).toEqual(['@']);
        // A webview-originated selectionChange must not echo setSelection back to the
        // webview, or rapid multi-select (click + Ctrl-click) ping-pongs between states.
        expect(postedMessages).not.toContainEqual(expect.objectContaining({ type: 'setSelection' }));

        // Host-originated setSelectedCommits still pushes setSelection to the webview.
        controller.setSelectedCommits(['c1', 'c2']);
        expect(postedMessages).toContainEqual({
            type: 'setSelection',
            payload: { ids: ['c1', 'c2'] },
        });
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

    test('cf.onDidUpdate re-populates commits without re-triggering ensureFreshStatuses', async () => {
        const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        const updateEmitter = new EventEmitter<void>();
        const mockProvider = createMock<CodeForgeProvider>({
            id: 'mock-provider',
            detect: async () => true,
            onDidUpdate: updateEmitter.event,
            getCachedChangeInfo: () => undefined,
            fetchStatuses: async () => false,
            clearCache: () => {},
            activate: () => {},
            deactivate: () => {},
        });
        registry.register({ id: 'mock-provider', create: () => mockProvider });
        await repo.codeForge.detectActiveProvider(true);

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
        const ensureFreshSpy = vi.spyOn(repo.codeForge, 'ensureFreshStatuses');
        const setCommitsSpy = vi.spyOn(controller, 'setCommits');

        // Fire onDidUpdate from provider
        updateEmitter.fire();

        expect(setCommitsSpy).toHaveBeenCalledWith(dummyCommits);
        expect(ensureFreshSpy).not.toHaveBeenCalled();
    });

    test('cf.onRequestRefresh triggers refreshCodeForge and ensureFreshStatuses', async () => {
        const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        const mockProvider = createMock<CodeForgeProvider>({
            id: 'mock-provider-2',
            detect: async () => true,
            onDidUpdate: new EventEmitter<void>().event,
            getCachedChangeInfo: () => undefined,
            fetchStatuses: vi.fn().mockResolvedValue(false),
            clearCache: () => {},
            activate: () => {},
            deactivate: () => {},
        });
        registry.register({ id: 'mock-provider-2', create: () => mockProvider });
        await repo.codeForge.detectActiveProvider(true);

        const dummyCommits: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'test-change-2',
                commit_id: 'test-commit-2',
                description: 'test commit 2',
                is_immutable: false,
                is_empty: false,
                conflict: false,
                bookmarks: [],
                tags: [],
                parents: [],
            }),
        ];

        controller.setCommits(dummyCommits);
        const ensureFreshSpy = vi.spyOn(repo.codeForge, 'ensureFreshStatuses');

        // Trigger force refresh on codeForge service (simulating post-upload backoff timer or poller)
        repo.codeForge.forceRefresh();

        expect(ensureFreshSpy).toHaveBeenCalled();
    });

    test('refreshCodeForge proceeds to fetch statuses when called before active provider detection completes', async () => {
        const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        const mockProvider = createMock<CodeForgeProvider>({
            id: 'mock-provider-startup',
            detect: async () => true,
            onDidUpdate: new EventEmitter<void>().event,
            getCachedChangeInfo: () => undefined,
            fetchStatuses: vi.fn().mockResolvedValue(false),
            clearCache: () => {},
            activate: () => {},
            deactivate: () => {},
        });
        registry.register({ id: 'mock-provider-startup', create: () => mockProvider });

        const dummyCommits: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'test-change-startup',
                commit_id: 'test-commit-startup',
                description: 'test commit startup',
                is_immutable: false,
                is_empty: false,
                conflict: false,
                bookmarks: [],
                tags: [],
                parents: [],
            }),
        ];

        controller.setCommits(dummyCommits);
        expect(repo.codeForge.isEnabled).toBe(false);

        const ensureFreshSpy = vi.spyOn(repo.codeForge, 'ensureFreshStatuses');

        await controller.refreshCodeForge();

        expect(repo.codeForge.isEnabled).toBe(true);
        expect(ensureFreshSpy).toHaveBeenCalledTimes(1);
    });

    test('refreshCodeForge coalesces concurrent calls into single execution', async () => {
        const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        let resolveFetch!: (val: boolean) => void;
        const fetchPromise = new Promise<boolean>((res) => {
            resolveFetch = res;
        });

        const mockProvider = createMock<CodeForgeProvider>({
            id: 'mock-provider-coalesce',
            detect: async () => true,
            onDidUpdate: new EventEmitter<void>().event,
            getCachedChangeInfo: () => undefined,
            fetchStatuses: vi.fn().mockImplementation(() => fetchPromise),
            clearCache: () => {},
            activate: () => {},
            deactivate: () => {},
        });
        registry.register({ id: 'mock-provider-coalesce', create: () => mockProvider });
        await repo.codeForge.detectActiveProvider(true);

        const dummyCommits: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'test-change-coalesce',
                commit_id: 'test-commit-coalesce',
                description: 'test commit coalesce',
                is_immutable: false,
                is_empty: false,
                conflict: false,
                bookmarks: [],
                tags: [],
                parents: [],
            }),
        ];

        controller.setCommits(dummyCommits);
        const ensureFreshSpy = vi.spyOn(repo.codeForge, 'ensureFreshStatuses');

        const p1 = controller.refreshCodeForge();
        const p2 = controller.refreshCodeForge();

        expect(ensureFreshSpy).toHaveBeenCalledTimes(1);

        resolveFetch(false);
        await Promise.all([p1, p2]);

        expect(ensureFreshSpy).toHaveBeenCalledTimes(1);
    });

    test('refreshCodeForge executes additional iteration when setCommits arrives during in-flight fetch', async () => {
        const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        let resolveFetch1!: (val: boolean) => void;
        let resolveFetch2!: (val: boolean) => void;
        let fetchCount = 0;
        const mockProvider = createMock<CodeForgeProvider>({
            id: 'mock-provider-rerun',
            detect: async () => true,
            onDidUpdate: new EventEmitter<void>().event,
            getCachedChangeInfo: () => undefined,
            fetchStatuses: vi.fn().mockImplementation(() => {
                fetchCount++;
                if (fetchCount === 1) {
                    return new Promise<boolean>((res) => {
                        resolveFetch1 = res;
                    });
                }
                return new Promise<boolean>((res) => {
                    resolveFetch2 = res;
                });
            }),
            clearCache: () => {},
            activate: () => {},
            deactivate: () => {},
        });
        registry.register({ id: 'mock-provider-rerun', create: () => mockProvider });
        await repo.codeForge.detectActiveProvider(true);

        const dummyCommits1: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'test-change-rerun-1',
                commit_id: 'test-commit-rerun-1',
                description: 'test commit rerun 1',
                is_immutable: false,
                is_empty: false,
                conflict: false,
                bookmarks: [],
                tags: [],
                parents: [],
            }),
        ];

        controller.setCommits(dummyCommits1);
        const ensureFreshSpy = vi.spyOn(repo.codeForge, 'ensureFreshStatuses');

        const refreshPromise = controller.refreshCodeForge();
        expect(ensureFreshSpy).toHaveBeenCalledTimes(1);

        // Update commits while the first fetch is in flight
        const dummyCommits2: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'test-change-rerun-2',
                commit_id: 'test-commit-rerun-2',
                description: 'test commit rerun 2',
                is_immutable: false,
                is_empty: false,
                conflict: false,
                bookmarks: [],
                tags: [],
                parents: [],
            }),
        ];
        controller.setCommits(dummyCommits2);

        // Complete the first fetch; the loop should detect version change and run pass 2
        resolveFetch1(false);

        // Allow microtasks to run and start pass 2
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(ensureFreshSpy).toHaveBeenCalledTimes(2);

        resolveFetch2(false);
        await refreshPromise;
        expect(ensureFreshSpy).toHaveBeenCalledTimes(2);
    });

    test('dispatches jj-view.compareWithUploaded command on compareWithUploaded message', async () => {
        const executeSpy = vi.spyOn(fakeHost.commands, 'executeCommand');

        const handled = await controller.handleMessage({
            type: 'compareWithUploaded',
            payload: { changeId: 'test-change-cl' },
        });

        expect(handled).toBe(true);
        expect(executeSpy).toHaveBeenCalledWith('jj-view.compareWithUploaded', 'test-change-cl');
    });

    describe('code forge fetch throttling (codeForge.minRefreshIntervalSeconds)', () => {
        async function setUpCodeForge() {
            const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
            if (!repo) {
                throw new Error('Repository not registered in test');
            }
            const fetchStatuses = vi.fn<CodeForgeProvider['fetchStatuses']>().mockResolvedValue(false);
            const mockProvider = createMock<CodeForgeProvider>({
                id: 'mock-provider-throttle',
                detect: async () => true,
                onDidUpdate: new EventEmitter<void>().event,
                getCachedChangeInfo: () => undefined,
                fetchStatuses,
                clearCache: () => {},
                activate: () => {},
                deactivate: () => {},
            });
            registry.register({ id: 'mock-provider-throttle', create: () => mockProvider });
            await repo.codeForge.detectActiveProvider(true);
            return { repo, fetchStatuses };
        }

        /** Waits for the fire-and-forget code forge fetch started by a log refresh to finish. */
        async function waitForFetchCount(fetchStatuses: Mock<CodeForgeProvider['fetchStatuses']>, count: number) {
            await vi.waitFor(() => expect(fetchStatuses).toHaveBeenCalledTimes(count));
            await vi.waitFor(() => {
                // The service stamps the fetch time once the provider call settles.
                expect(fetchStatuses.mock.settledResults.length).toBe(count);
            });
        }

        test('fetches on every log refresh when unset', async () => {
            const { fetchStatuses } = await setUpCodeForge();

            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 2);
        });

        test('skips the fetch for log refreshes inside the window', async () => {
            const { repo, fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);

            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);
            expect(repo.codeForge.isWithinMinRefreshInterval()).toBe(true);

            await controller.refresh('fileChange');
            await controller.refresh('mutationComplete');

            expect(fetchStatuses).toHaveBeenCalledTimes(1);
        });

        test('fetches the throttled changes once the window ends', async () => {
            const { fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            // Fake only the clock and timeouts; jj subprocesses still run on real I/O.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            // Two throttled refreshes inside the window coalesce into one trailing fetch.
            await controller.refresh('fileChange');
            await controller.refresh('fileChange');
            expect(fetchStatuses).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(30_000);
            await waitForFetchCount(fetchStatuses, 2);
            await vi.advanceTimersByTimeAsync(10 * 60_000);

            expect(fetchStatuses).toHaveBeenCalledTimes(2);
        });

        test('a deferred refresh is not swallowed by a fetch that began with older commits', async () => {
            const { repo, fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

            // A poller tick starts a slow fetch with the current commits.
            let finishFetch!: (changed: boolean) => void;
            fetchStatuses.mockImplementationOnce(
                () =>
                    new Promise<boolean>((resolve) => {
                        finishFetch = resolve;
                    }),
            );
            repo.codeForge.forceRefresh();
            await vi.waitFor(() => expect(fetchStatuses).toHaveBeenCalledTimes(2));

            // A throttled log refresh brings in a new commit meanwhile.
            testRepo.new(undefined, 'newer');
            const newerChangeId = testRepo.getChangeId('@');
            await controller.refresh('fileChange');
            expect(fetchStatuses).toHaveBeenCalledTimes(2);

            // The deferred refresh fires while the slow fetch runs; a further fetch must then cover the new commit.
            await vi.advanceTimersByTimeAsync(30_000);
            finishFetch(false);
            await waitForFetchCount(fetchStatuses, 3);

            const lastChanges = fetchStatuses.mock.calls[2][0];
            expect(lastChanges.map((c) => c.changeId)).toContain(newerChangeId);
        });

        test('still refreshes the log itself when the fetch is skipped', async () => {
            const { fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            const setCommitsSpy = vi.spyOn(controller, 'setCommits');
            await controller.refresh('fileChange');

            expect(setCommitsSpy).toHaveBeenCalledTimes(1);
        });

        test('manual refreshes bypass the throttle once', async () => {
            const { fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            await controller.refresh(MANUAL_REFRESH_REASON);
            await waitForFetchCount(fetchStatuses, 2);

            // The manual fetch restarted the window, and the bypass is not sticky.
            await controller.refresh('fileChange');
            expect(fetchStatuses).toHaveBeenCalledTimes(2);
        });

        test('manual refreshes are recognised among combined reasons', async () => {
            const { fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            await controller.refresh(`fileChange, ${MANUAL_REFRESH_REASON}`);
            await waitForFetchCount(fetchStatuses, 2);
        });

        test('a manual refresh that fails before the fetch keeps its bypass for the retry', async () => {
            const { repo, fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            // `jj log` fails on an invalid default revset.
            testRepo.config('revsets.log', '(((');
            try {
                await controller.refresh(MANUAL_REFRESH_REASON);
            } finally {
                testRepo.removeConfig('revsets.log');
            }
            expect(fetchStatuses).toHaveBeenCalledTimes(1);
            expect(repo.codeForge.isWithinMinRefreshInterval()).toBe(true);

            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 2);
        });

        test('a throttled log refresh does not make an in-flight fetch run again', async () => {
            const { repo, fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            // Start a fetch that is not throttled (a poller tick) and hold it open.
            let finishFetch!: (changed: boolean) => void;
            fetchStatuses.mockImplementationOnce(
                () =>
                    new Promise<boolean>((resolve) => {
                        finishFetch = resolve;
                    }),
            );
            repo.codeForge.forceRefresh();
            await vi.waitFor(() => expect(fetchStatuses).toHaveBeenCalledTimes(2));

            // A throttled refresh mid-fetch must not make the running refresh fetch again.
            await controller.refresh('fileChange');
            finishFetch(false);
            await waitForFetchCount(fetchStatuses, 2);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(fetchStatuses).toHaveBeenCalledTimes(2);
        });

        test('explicit code forge refresh requests are never throttled', async () => {
            const { repo, fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            // Poller ticks, post-upload backoffs and auth changes all go through forceRefresh.
            repo.codeForge.forceRefresh();
            await waitForFetchCount(fetchStatuses, 2);
        });

        test('graph mutations do not bypass minRefreshIntervalSeconds via jj-view.refresh', async () => {
            testRepo.writeFile('bm.txt', 'content\n');
            testRepo.bookmark('bm', '@');
            testRepo.new(undefined, 'child');

            const { fetchStatuses } = await setUpCodeForge();
            fakeHost.config.set('codeForge.minRefreshIntervalSeconds', 3600);
            await controller.refresh('fileChange');
            await waitForFetchCount(fetchStatuses, 1);

            const executeSpy = vi.spyOn(fakeHost.commands, 'executeCommand');
            await controller.handleMessage({
                type: 'moveBookmark',
                payload: { bookmark: 'bm', targetChangeId: '@' },
            });

            expect(executeSpy).not.toHaveBeenCalledWith('jj-view.refresh');
            expect(fetchStatuses).toHaveBeenCalledTimes(1);
        });

        test('switching repository isolates in-flight refreshCodeForge from the new repository', async () => {
            const { repo: repo1, fetchStatuses: repo1Fetch } = await setUpCodeForge();
            const repo2Temp = new TestRepo();
            try {
                repo2Temp.init();
                repo2Temp.writeFile('other.txt', 'hello\n');
                repo2Temp.describe('second repo commit');
                fakeHost.workspace.addFolder(Uri.file(repo2Temp.path));
                const repo2 = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(repo2Temp.path));
                if (!repo2) {
                    throw new Error('Second repository not registered in test');
                }
                await repo2.watcher.dispose();
                await repo2.activeRefresh;

                const repo1EnsureSpy = vi.spyOn(repo1.codeForge, 'ensureFreshStatuses');
                const repo2EnsureSpy = vi.spyOn(repo2.codeForge, 'ensureFreshStatuses');

                await controller.refresh('fileChange');
                await waitForFetchCount(repo1Fetch, 1);

                let finishRepo1Fetch!: (changed: boolean) => void;
                repo1Fetch.mockImplementationOnce(
                    () =>
                        new Promise<boolean>((resolve) => {
                            finishRepo1Fetch = resolve;
                        }),
                );

                // Start an in-flight refreshCodeForge on repo1, then switch to repo2 before it finishes.
                const inFlightRepo1 = controller.refreshCodeForge();
                await vi.waitFor(() => expect(repo1EnsureSpy).toHaveBeenCalledTimes(2));

                controller.repository = repo2;
                await vi.waitFor(() => expect(repo2EnsureSpy).toHaveBeenCalledTimes(1));

                // Settling repo1's in-flight fetch must not trigger another repo1 fetch using repo2's commits.
                finishRepo1Fetch(false);
                await inFlightRepo1;
                await new Promise((resolve) => setTimeout(resolve, 0));

                expect(repo1EnsureSpy).toHaveBeenCalledTimes(2);
                expect(repo2EnsureSpy).toHaveBeenCalledTimes(1);
            } finally {
                await repo2Temp.dispose();
            }
        });
    });

    test('initial undefined repo sends hasRepository: false on getState and webviewLoaded', async () => {
        const messages: unknown[] = [];
        const unattached = new LogViewController(undefined, fakeHost, {
            messenger: {
                postMessage: (m) => messages.push(m),
            },
        });

        try {
            expect(unattached.hasRepository).toBe(false);
            expect(unattached.errorMessage).toBeUndefined();
            expect(unattached.getState()).toMatchObject({
                commits: [],
                hasRepository: false,
            });
            expect(unattached.getState().errorMessage).toBeUndefined();

            // Calling setter with undefined while already undefined must leave hasRepository false
            // and webviewLoaded must still refresh and broadcast hasRepository: false.
            unattached.repository = undefined;
            messages.length = 0;

            const handled = await unattached.handleMessage({ type: 'webviewLoaded' });
            expect(handled).toBe(true);
            expect(unattached.hasRepository).toBe(false);
            expect(unattached.errorMessage).toBeUndefined();
            expect(messages.at(-1)).toEqual({
                type: 'update',
                payload: expect.objectContaining({
                    commits: [],
                    hasRepository: false,
                }),
            });
            const lastPayload = (messages.at(-1) as { payload: { errorMessage?: string } }).payload;
            expect(lastPayload.errorMessage).toBeUndefined();
        } finally {
            unattached.dispose();
        }
    });

    test('invalid repository without .jj sends hasRepository: false and clears commits', async () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-invalid-repo-'));
        const messages: unknown[] = [];
        let invalidRepo: JjRepository | undefined;
        let invalidController: LogViewController | undefined;

        try {
            const outputChannel = createMockLogOutputChannel({
                appendLine: () => {},
            });
            invalidRepo = new JjRepository(
                Uri.file(emptyDir),
                path.join(emptyDir, '.jj', 'repo'),
                registry,
                outputChannel,
                fakeHost,
            );
            invalidController = new LogViewController(invalidRepo, fakeHost, {
                messenger: {
                    postMessage: (m) => messages.push(m),
                },
            });

            await invalidRepo.watcher.dispose();
            await invalidController.refresh('test-invalid');

            expect(invalidController.hasRepository).toBe(false);
            expect(invalidController.errorMessage).toBeUndefined();
            expect(invalidController.commits).toEqual([]);
            expect(messages.at(-1)).toEqual({
                type: 'update',
                payload: expect.objectContaining({
                    commits: [],
                    hasRepository: false,
                }),
            });
        } finally {
            invalidController?.dispose();
            await invalidRepo?.dispose();
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    });

    test('getLog failure sends errorMessage, keeps hasRepository: true, and exits loading', async () => {
        const brokenRepo = new TestRepo();
        const messages: unknown[] = [];
        let brokenController: LogViewController | undefined;
        let brokenJjRepo: JjRepository | undefined;
        const errorLogs: string[] = [];
        const logger = createMockLogOutputChannel({
            error: (msg: string) => {
                errorLogs.push(msg);
            },
        });

        try {
            brokenRepo.init();
            const outputChannel = createMockLogOutputChannel({
                appendLine: () => {},
            });
            brokenJjRepo = new JjRepository(
                Uri.file(brokenRepo.path),
                path.join(brokenRepo.path, '.jj', 'repo'),
                registry,
                outputChannel,
                fakeHost,
                '/non/existent/jj-binary',
            );
            await brokenJjRepo.watcher.dispose();

            brokenController = new LogViewController(brokenJjRepo, fakeHost, {
                logger,
                messenger: {
                    postMessage: (m) => messages.push(m),
                },
            });

            const handled = await brokenController.handleMessage({ type: 'webviewLoaded' });
            expect(handled).toBe(true);
            expect(brokenController.hasRepository).toBe(true);
            expect(brokenController.errorMessage).toBeTruthy();
            expect(brokenController.commits).toEqual([]);
            expect(errorLogs.some((msg) => msg.includes('[LogViewController] Failed to fetch log'))).toBe(true);

            const lastMsg = messages.at(-1) as {
                type: string;
                payload: { commits: unknown[]; hasRepository?: boolean; errorMessage?: string };
            };
            expect(lastMsg.type).toBe('update');
            expect(lastMsg.payload.commits).toEqual([]);
            expect(lastMsg.payload.hasRepository).toBe(true);
            expect(lastMsg.payload.errorMessage).toBe(brokenController.errorMessage);
        } finally {
            brokenController?.dispose();
            await brokenJjRepo?.dispose();
            await brokenRepo.dispose();
        }
    });

    test('preserves loaded commits when a subsequent refresh fails transiently on the same repo', async () => {
        testRepo.writeFile('file.txt', 'hello\n');
        testRepo.describe('loaded commit');
        await controller.refresh('initial-load');
        expect(controller.commits.length).toBeGreaterThan(0);

        const repo = controller.repository;
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        const originalBinary = repo.jj.binaryPath;
        repo.jj.binaryPath = '/non/existent/jj-binary';
        try {
            postedMessages.length = 0;
            await controller.refresh('transient-failure');
            expect(controller.hasRepository).toBe(true);
            expect(controller.errorMessage).toBeTruthy();
            expect(controller.commits.length).toBeGreaterThan(0);
            expect(postedMessages.at(-1)).toEqual({
                type: 'update',
                payload: expect.objectContaining({
                    hasRepository: true,
                    errorMessage: controller.errorMessage,
                }),
            });
        } finally {
            repo.jj.binaryPath = originalBinary;
        }
    });

    test('attaching a valid TestRepo clears errorMessage, sets hasRepository: true, and loads commits', async () => {
        const brokenRepo = new TestRepo();
        const validRepo = new TestRepo();
        const messages: unknown[] = [];
        let testController: LogViewController | undefined;
        let brokenJjRepo: JjRepository | undefined;
        let validJjRepo: JjRepository | undefined;

        try {
            brokenRepo.init();
            validRepo.init();
            validRepo.writeFile('hello.txt', 'world\n');
            validRepo.describe('feat: valid attached commit');

            const outputChannel = createMockLogOutputChannel({
                appendLine: () => {},
            });
            brokenJjRepo = new JjRepository(
                Uri.file(brokenRepo.path),
                path.join(brokenRepo.path, '.jj', 'repo'),
                registry,
                outputChannel,
                fakeHost,
                '/non/existent/jj-binary',
            );
            await brokenJjRepo.watcher.dispose();

            validJjRepo = new JjRepository(
                Uri.file(validRepo.path),
                path.join(validRepo.path, '.jj', 'repo'),
                registry,
                outputChannel,
                fakeHost,
            );
            await validJjRepo.watcher.dispose();

            testController = new LogViewController(brokenJjRepo, fakeHost, {
                messenger: {
                    postMessage: (m) => messages.push(m),
                },
            });

            await testController.refresh('initial-broken');
            expect(testController.errorMessage).toBeTruthy();
            expect(testController.commits).toEqual([]);

            // Attach valid repository via setter
            testController.repository = validJjRepo;
            expect(testController.hasRepository).toBe(true);
            expect(testController.errorMessage).toBeUndefined();

            // Wait for setter-triggered refresh to settle
            await testController.refresh('wait-valid');

            expect(testController.hasRepository).toBe(true);
            expect(testController.errorMessage).toBeUndefined();
            expect(testController.commits.length).toBeGreaterThan(0);
            expect(testController.commits.some((c) => c.description.includes('feat: valid attached commit'))).toBe(
                true,
            );

            const lastMsg = messages.at(-1) as {
                type: string;
                payload: { commits: JjLogEntry[]; hasRepository?: boolean; errorMessage?: string };
            };
            expect(lastMsg.type).toBe('update');
            expect(lastMsg.payload.hasRepository).toBe(true);
            expect(lastMsg.payload.errorMessage).toBeUndefined();
            expect(lastMsg.payload.commits.some((c) => c.description.includes('feat: valid attached commit'))).toBe(
                true,
            );

            // Clearing repository back to undefined clears commits and sets hasRepository: false
            testController.repository = undefined;
            await testController.refresh('wait-cleared');
            expect(testController.hasRepository).toBe(false);
            expect(testController.errorMessage).toBeUndefined();
            expect(testController.commits).toEqual([]);
        } finally {
            testController?.dispose();
            await brokenJjRepo?.dispose();
            await validJjRepo?.dispose();
            await brokenRepo.dispose();
            await validRepo.dispose();
        }
    });

    test('webviewLoaded with attached repo suppresses premature blank update until initial refresh settles', async () => {
        testRepo.writeFile('hello.txt', 'settled\n');
        testRepo.describe('feat: settled initial commit');

        const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
        expect(repo).toBeDefined();
        if (!repo) {
            return;
        }

        const messages: unknown[] = [];
        const freshController = new LogViewController(repo, fakeHost, {
            messenger: {
                postMessage: (m) => messages.push(m),
            },
        });

        try {
            // Unsettled attached repo must not push an empty commits: [] snapshot on attach
            expect(messages).toEqual([]);

            await freshController.handleMessage({ type: 'webviewLoaded' });
            const updateMsgs = messages.filter(
                (m): m is { type: string; payload: { commits: JjLogEntry[]; hasRepository?: boolean } } =>
                    typeof m === 'object' && m !== null && 'type' in m && m.type === 'update',
            );
            expect(updateMsgs).toHaveLength(1);
            expect(updateMsgs[0].payload.hasRepository).toBe(true);
            expect(
                updateMsgs[0].payload.commits.some((c) => c.description.includes('feat: settled initial commit')),
            ).toBe(true);
        } finally {
            freshController.dispose();
        }
    });

    test('discards stale validation and same-path instance fetches across repository switches and disposal', async () => {
        let repoA: TestRepo | undefined;
        let repoB: TestRepo | undefined;
        const noopWatcher: HostWatcher = {
            watch: async () => ({ unsubscribe: async () => {} }),
        };

        let controllerA: LogViewController | undefined;
        let jjRepoA1: JjRepository | undefined;
        let jjRepoA2: JjRepository | undefined;
        let jjRepoB: JjRepository | undefined;

        try {
            repoA = new TestRepo();
            repoB = new TestRepo();
            repoA.init();
            repoA.writeFile('a.txt', 'a\n');
            repoA.describe('feat: repo A commit');

            repoB.init();
            repoB.writeFile('b.txt', 'b\n');
            repoB.describe('feat: repo B commit');

            const norm = (p: string): string => {
                const resolved = Uri.file(path.resolve(p)).fsPath;
                return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            };
            const expectedRepoATypePath = norm(path.join(repoA.path, '.jj', 'working_copy', 'type'));

            let notifyExistsStarted!: () => void;
            const existsStarted = new Promise<void>((resolve) => {
                notifyExistsStarted = resolve;
            });
            let releaseExists: (() => void) | undefined;
            const deferredExists = new Promise<void>((resolve) => {
                releaseExists = resolve;
            });
            let blockExists = true;

            class DeferredExistsFs extends NodeHostFs {
                override async exists(targetPath: string): Promise<boolean> {
                    if (blockExists && norm(targetPath) === expectedRepoATypePath) {
                        blockExists = false;
                        notifyExistsStarted();
                        await deferredExists;
                        return false;
                    }
                    return super.exists(targetPath);
                }
            }

            let onLogIntercept: (() => Promise<void>) | undefined;

            class DeferredLogProcess extends NodeHostProcess {
                override async execFile(
                    file: string,
                    args: readonly string[],
                    options?: ProcessExecOptions,
                ): Promise<ProcessResult> {
                    if (onLogIntercept && args.includes('log')) {
                        const intercept = onLogIntercept;
                        onLogIntercept = undefined;
                        await intercept();
                    }
                    return super.execFile(file, args, options);
                }
            }

            const deferredHost = new FakeHostEnvironment(
                new NodeHostSystem({
                    fs: new DeferredExistsFs(),
                    process: new DeferredLogProcess(),
                    watcher: noopWatcher,
                }),
            );
            const outputChannel = createMockLogOutputChannel({
                appendLine: () => {},
            });

            jjRepoA1 = new JjRepository(
                Uri.file(repoA.path),
                path.join(repoA.path, '.jj', 'repo'),
                registry,
                outputChannel,
                deferredHost,
            );
            await jjRepoA1.watcher.dispose();

            jjRepoB = new JjRepository(
                Uri.file(repoB.path),
                path.join(repoB.path, '.jj', 'repo'),
                registry,
                outputChannel,
                deferredHost,
            );
            await jjRepoB.watcher.dispose();

            const messages: unknown[] = [];
            controllerA = new LogViewController(jjRepoA1, deferredHost, {
                messenger: {
                    postMessage: (m) => messages.push(m),
                },
            });

            let releaseA1Log: (() => void) | undefined;
            let releaseDisposeLog: (() => void) | undefined;
            let inFlightValidationRefresh: Promise<void> | undefined;
            let inFlightA1Fetch: Promise<void> | undefined;
            let disposeFetch: Promise<void> | undefined;

            try {
                // 1. Start refresh while isValid() is blocked on jjRepoA1, then switch to jjRepoB
                inFlightValidationRefresh = controllerA.refresh('blocked-validation');
                await existsStarted;
                messages.length = 0;
                controllerA.repository = jjRepoB;

                // Release stale false validation for jjRepoA1 -> must NOT emit hasRepository:false or clobber repo B
                releaseExists?.();
                await inFlightValidationRefresh;
                await controllerA.refresh('settle-B');

                expect(controllerA.hasRepository).toBe(true);
                expect(controllerA.commits.some((c) => c.description.includes('feat: repo B commit'))).toBe(true);
                const repoBUpdates = messages
                    .filter(
                        (
                            m,
                        ): m is {
                            type: string;
                            payload: { hasRepository?: boolean; commits: JjLogEntry[] };
                        } => typeof m === 'object' && m !== null && 'type' in m && m.type === 'update',
                    )
                    .map((m) => m.payload);
                expect(repoBUpdates.some((p) => p.hasRepository === false)).toBe(false);
                expect(repoBUpdates.at(-1)?.commits.some((c) => c.description.includes('feat: repo B commit'))).toBe(
                    true,
                );

                // 2. Replace jjRepoA1 with a new instance jjRepoA2 at the exact same rootUri.fsPath while A1 getLog is in flight
                controllerA.repository = jjRepoA1;
                await controllerA.refresh('settle-A1');
                expect(controllerA.commits.some((c) => c.description.includes('feat: repo A commit'))).toBe(true);

                let notifyA1LogStarted!: () => void;
                const a1LogStarted = new Promise<void>((resolve) => {
                    notifyA1LogStarted = resolve;
                });
                const deferredA1Log = new Promise<void>((resolve) => {
                    releaseA1Log = resolve;
                });
                onLogIntercept = async () => {
                    notifyA1LogStarted();
                    await deferredA1Log;
                };

                inFlightA1Fetch = controllerA.refresh('blocked-A1-log');
                await a1LogStarted;

                jjRepoA2 = new JjRepository(
                    Uri.file(repoA.path),
                    path.join(repoA.path, '.jj', 'repo'),
                    registry,
                    outputChannel,
                    deferredHost,
                    '/non/existent/jj-binary',
                );
                await jjRepoA2.watcher.dispose();

                messages.length = 0;
                // Must NOT early-return despite identical fsPath!
                controllerA.repository = jjRepoA2;
                expect(controllerA.repository).toBe(jjRepoA2);

                // Release stale successful A1 fetch -> must be discarded without emitting commits, then A2 settles in error
                releaseA1Log?.();
                await inFlightA1Fetch;
                await controllerA.refresh('settle-A2');
                expect(controllerA.errorMessage).toBeTruthy();
                expect(controllerA.commits).toEqual([]);
                const repoA2Updates = messages
                    .filter(
                        (
                            m,
                        ): m is {
                            type: string;
                            payload: { errorMessage?: string; commits: JjLogEntry[] };
                        } => typeof m === 'object' && m !== null && 'type' in m && m.type === 'update',
                    )
                    .map((m) => m.payload);
                expect(
                    repoA2Updates.some((p) => p.commits.some((c) => c.description.includes('feat: repo A commit'))),
                ).toBe(false);
                expect(repoA2Updates.at(-1)?.errorMessage).toBeTruthy();

                // 3. Disposal while getLog is in flight discards error/success without posting
                const validHost = new FakeHostEnvironment(
                    new NodeHostSystem({
                        process: new DeferredLogProcess(),
                        watcher: noopWatcher,
                    }),
                );
                const jjRepoA3 = new JjRepository(
                    Uri.file(repoA.path),
                    path.join(repoA.path, '.jj', 'repo'),
                    registry,
                    outputChannel,
                    validHost,
                );
                await jjRepoA3.watcher.dispose();
                const disposableController = new LogViewController(jjRepoA3, validHost, {
                    messenger: {
                        postMessage: (m) => messages.push(m),
                    },
                });
                try {
                    let notifyDisposeLogStarted!: () => void;
                    const disposeLogStarted = new Promise<void>((resolve) => {
                        notifyDisposeLogStarted = resolve;
                    });
                    const deferredDisposeLog = new Promise<void>((resolve) => {
                        releaseDisposeLog = resolve;
                    });
                    onLogIntercept = async () => {
                        notifyDisposeLogStarted();
                        await deferredDisposeLog;
                    };

                    disposeFetch = disposableController.refresh('dispose-mid-fetch');
                    await disposeLogStarted;
                    messages.length = 0;
                    disposableController.dispose();
                    releaseDisposeLog?.();
                    await disposeFetch;
                    expect(messages).toEqual([]);
                } finally {
                    releaseDisposeLog?.();
                    await Promise.allSettled([disposeFetch]);
                    disposableController.dispose();
                    await jjRepoA3.dispose();
                }
            } finally {
                releaseExists?.();
                releaseA1Log?.();
                releaseDisposeLog?.();
                await Promise.allSettled([inFlightValidationRefresh, inFlightA1Fetch, disposeFetch]);
            }
        } finally {
            controllerA?.dispose();
            await jjRepoA1?.dispose();
            await jjRepoA2?.dispose();
            await jjRepoB?.dispose();
            await repoA?.dispose();
            await repoB?.dispose();
        }
    });

    test('refresh bypasses stale isValid cache when .jj directory appears or disappears on disk', async () => {
        const dynamicTestRepo = new TestRepo();
        const dynamicDir = dynamicTestRepo.path;
        let dynamicRepo: JjRepository | undefined;
        let dynamicController: LogViewController | undefined;

        try {
            const outputChannel = createMockLogOutputChannel({
                appendLine: () => {},
            });
            dynamicRepo = new JjRepository(
                Uri.file(dynamicDir),
                path.join(dynamicDir, '.jj', 'repo'),
                registry,
                outputChannel,
                fakeHost,
            );
            await dynamicRepo.watcher.dispose();

            dynamicController = new LogViewController(dynamicRepo, fakeHost);
            await dynamicController.refresh('initially-missing');
            expect(dynamicController.hasRepository).toBe(false);

            // Simulate initializing .jj on disk without recreating JjRepository
            dynamicTestRepo.init();
            dynamicTestRepo.describe('feat: initialized later');

            await dynamicController.refresh('after-init');
            expect(dynamicController.hasRepository).toBe(true);
            expect(dynamicController.commits.some((c) => c.description.includes('feat: initialized later'))).toBe(true);

            // Remove .jj/working_copy/type and refresh again -> returns to hasRepository: false
            fs.rmSync(path.join(dynamicDir, '.jj', 'working_copy', 'type'), { force: true });
            await dynamicController.refresh('after-delete');
            expect(dynamicController.hasRepository).toBe(false);
            expect(dynamicController.commits).toEqual([]);
        } finally {
            dynamicController?.dispose();
            await dynamicRepo?.dispose();
            await dynamicTestRepo.dispose();
        }
    });

    test('config and theme setters defer update notifications until initial refresh settles', async () => {
        let repo1: TestRepo | undefined;
        let repo2: TestRepo | undefined;
        let jjRepo1: JjRepository | undefined;
        let jjRepo2: JjRepository | undefined;
        let controller: LogViewController | undefined;

        try {
            repo1 = new TestRepo();
            repo1.init();
            repo1.writeFile('one.txt', '1\n');
            repo1.describe('feat: settled config repo1');

            repo2 = new TestRepo();
            repo2.init();
            repo2.writeFile('two.txt', '2\n');
            repo2.describe('feat: settled config repo2');

            const noopWatcher: HostWatcher = {
                watch: async () => ({ unsubscribe: async () => {} }),
            };
            const quietHost = new FakeHostEnvironment(new NodeHostSystem({ watcher: noopWatcher }));
            const outputChannel = createMockLogOutputChannel({ appendLine: () => {} });

            jjRepo1 = new JjRepository(
                Uri.file(repo1.path),
                path.join(repo1.path, '.jj', 'repo'),
                registry,
                outputChannel,
                quietHost,
            );
            await jjRepo1.watcher.dispose();

            jjRepo2 = new JjRepository(
                Uri.file(repo2.path),
                path.join(repo2.path, '.jj', 'repo'),
                registry,
                outputChannel,
                quietHost,
            );
            await jjRepo2.watcher.dispose();

            const messages: unknown[] = [];
            controller = new LogViewController(jjRepo1, quietHost, {
                messenger: {
                    postMessage: (m) => messages.push(m),
                },
            });

            expect(controller.hasSettledState).toBe(false);
            controller.updateConfig({ theme: 'dark', graphLabelAlignment: 'inline', minChangeIdLength: 4 });
            controller.setTheme('light');
            controller.setGraphLabelAlignment('aligned');
            controller.updateTheme('high-contrast');
            expect(messages).toEqual([]);

            await controller.refresh('settle-1');
            expect(controller.hasSettledState).toBe(true);
            const settledUpdate = messages.find(
                (
                    m,
                ): m is {
                    type: 'update';
                    payload: {
                        theme?: string;
                        graphLabelAlignment?: string;
                        minChangeIdLength?: number;
                        commits: JjLogEntry[];
                    };
                } => typeof m === 'object' && m !== null && 'type' in m && m.type === 'update',
            );
            expect(settledUpdate?.payload.theme).toBe('high-contrast');
            expect(settledUpdate?.payload.graphLabelAlignment).toBe('aligned');
            expect(settledUpdate?.payload.minChangeIdLength).toBe(4);
            expect(
                settledUpdate?.payload.commits.some((c) => c.description.includes('feat: settled config repo1')),
            ).toBe(true);

            messages.length = 0;
            controller.updateTheme('nord');
            expect(messages).toHaveLength(1);

            controller.repository = jjRepo2;
            expect(controller.hasSettledState).toBe(false);
            messages.length = 0;
            controller.setTheme('dracula');
            expect(messages).toEqual([]);

            await controller.refresh('settle-2');
            expect(controller.hasSettledState).toBe(true);
            const repo2Update = messages
                .filter(
                    (m): m is { type: 'update'; payload: { theme?: string; commits: JjLogEntry[] } } =>
                        typeof m === 'object' && m !== null && 'type' in m && m.type === 'update',
                )
                .at(-1);
            expect(repo2Update?.payload.theme).toBe('dracula');
            expect(repo2Update?.payload.commits.some((c) => c.description.includes('feat: settled config repo2'))).toBe(
                true,
            );
        } finally {
            controller?.dispose();
            await jjRepo1?.dispose();
            await jjRepo2?.dispose();
            await repo1?.dispose();
            await repo2?.dispose();
        }
    });

    test('A-B-A same-instance repository switch discards stale first fetch via repoChangeVersion', async () => {
        let repoA: TestRepo | undefined;
        let repoB: TestRepo | undefined;
        let jjRepoA: JjRepository | undefined;
        let jjRepoB: JjRepository | undefined;
        let controller: LogViewController | undefined;
        let releaseCapturedReturn: (() => void) | undefined;
        let firstFetch: Promise<void> | undefined;

        try {
            repoA = new TestRepo();
            repoA.init();
            repoA.writeFile('a.txt', 'a\n');
            repoA.describe('feat: repo A initial');

            repoB = new TestRepo();
            repoB.init();
            repoB.writeFile('b.txt', 'b\n');
            repoB.describe('feat: repo B middle');

            let notifyCaptured!: () => void;
            const captured = new Promise<void>((resolve) => {
                notifyCaptured = resolve;
            });
            const deferredReturn = new Promise<void>((resolve) => {
                releaseCapturedReturn = resolve;
            });
            let holdNextPostLog = true;

            class PostExecHoldLogProcess extends NodeHostProcess {
                override async execFile(
                    file: string,
                    args: readonly string[],
                    options?: ProcessExecOptions,
                ): Promise<ProcessResult> {
                    const shouldHold = holdNextPostLog && args.includes('log');
                    if (shouldHold) {
                        holdNextPostLog = false;
                    }
                    const result = await super.execFile(file, args, options);
                    if (shouldHold) {
                        notifyCaptured();
                        await deferredReturn;
                    }
                    return result;
                }
            }

            const noopWatcher: HostWatcher = {
                watch: async () => ({ unsubscribe: async () => {} }),
            };
            const host = new FakeHostEnvironment(
                new NodeHostSystem({
                    process: new PostExecHoldLogProcess(),
                    watcher: noopWatcher,
                }),
            );
            const outputChannel = createMockLogOutputChannel({ appendLine: () => {} });

            jjRepoA = new JjRepository(
                Uri.file(repoA.path),
                path.join(repoA.path, '.jj', 'repo'),
                registry,
                outputChannel,
                host,
            );
            await jjRepoA.watcher.dispose();

            jjRepoB = new JjRepository(
                Uri.file(repoB.path),
                path.join(repoB.path, '.jj', 'repo'),
                registry,
                outputChannel,
                host,
            );
            await jjRepoB.watcher.dispose();

            const messages: unknown[] = [];
            controller = new LogViewController(jjRepoA, host, {
                messenger: {
                    postMessage: (m) => messages.push(m),
                },
            });

            firstFetch = controller.refresh('first-A');
            await captured;

            repoA.describe('feat: repo A v2');
            messages.length = 0;
            controller.repository = jjRepoB;
            controller.repository = jjRepoA;

            releaseCapturedReturn?.();
            await firstFetch;
            await controller.refresh('settle-ABA');

            const emittedDescriptions = messages
                .filter(
                    (m): m is { type: 'update'; payload: { commits: JjLogEntry[] } } =>
                        typeof m === 'object' && m !== null && 'type' in m && m.type === 'update',
                )
                .flatMap((m) => m.payload.commits.map((c) => c.description));

            expect(emittedDescriptions.some((d) => d.includes('feat: repo A initial'))).toBe(false);
            expect(controller.commits.some((c) => c.description.includes('feat: repo A v2'))).toBe(true);
        } finally {
            releaseCapturedReturn?.();
            await Promise.allSettled([firstFetch]);
            controller?.dispose();
            await jjRepoA?.dispose();
            await jjRepoB?.dispose();
            await repoA?.dispose();
            await repoB?.dispose();
        }
    });

    test('detached updates are not queued across unsettled repo switch when messenger attaches later, and disposed setCommits is a no-op', async () => {
        let repo1: TestRepo | undefined;
        let repo2: TestRepo | undefined;
        let jjRepo1: JjRepository | undefined;
        let jjRepo2: JjRepository | undefined;
        let controller: LogViewController | undefined;
        let releaseRepo2Log: (() => void) | undefined;

        try {
            repo1 = new TestRepo();
            repo1.init();
            repo1.writeFile('one.txt', '1\n');
            repo1.describe('feat: detached repo1');

            repo2 = new TestRepo();
            repo2.init();
            repo2.writeFile('two.txt', '2\n');
            repo2.describe('feat: detached repo2');

            let notifyRepo2LogStarted!: () => void;
            const repo2LogStarted = new Promise<void>((resolve) => {
                notifyRepo2LogStarted = resolve;
            });
            const deferredRepo2Log = new Promise<void>((resolve) => {
                releaseRepo2Log = resolve;
            });
            let blockNextLog = false;

            class DeferredLogProcess extends NodeHostProcess {
                override async execFile(
                    file: string,
                    args: readonly string[],
                    options?: ProcessExecOptions,
                ): Promise<ProcessResult> {
                    if (blockNextLog && args.includes('log')) {
                        blockNextLog = false;
                        notifyRepo2LogStarted();
                        await deferredRepo2Log;
                    }
                    return super.execFile(file, args, options);
                }
            }

            const noopWatcher: HostWatcher = {
                watch: async () => ({ unsubscribe: async () => {} }),
            };
            const host = new FakeHostEnvironment(
                new NodeHostSystem({
                    process: new DeferredLogProcess(),
                    watcher: noopWatcher,
                }),
            );
            const outputChannel = createMockLogOutputChannel({ appendLine: () => {} });

            jjRepo1 = new JjRepository(
                Uri.file(repo1.path),
                path.join(repo1.path, '.jj', 'repo'),
                registry,
                outputChannel,
                host,
            );
            await jjRepo1.watcher.dispose();

            jjRepo2 = new JjRepository(
                Uri.file(repo2.path),
                path.join(repo2.path, '.jj', 'repo'),
                registry,
                outputChannel,
                host,
            );
            await jjRepo2.watcher.dispose();

            // Settle no-repo and then repo1 while no messenger is attached
            controller = new LogViewController(undefined, host);
            await controller.refresh('detached-empty');
            controller.repository = jjRepo1;
            await controller.refresh('detached-repo1');
            expect(controller.commits.some((c) => c.description.includes('feat: detached repo1'))).toBe(true);

            // Switch to unsettled jjRepo2 (blocked in jj log), then attach messenger before jjRepo2 settles
            blockNextLog = true;
            controller.repository = jjRepo2;
            await repo2LogStarted;

            const newMessages: unknown[] = [];
            controller.setMessenger({
                postMessage: (m) => newMessages.push(m),
            });

            // Stale detached updates (hasRepository:false / repo1 commits) must NOT replay onto the newly attached messenger
            expect(newMessages).toEqual([]);

            let settledRepo2 = false;
            const settledSub = controller.onDidUpdateCommits(() => {
                settledRepo2 = true;
            });
            try {
                releaseRepo2Log?.();
                await expect.poll(() => settledRepo2).toBe(true);
            } finally {
                settledSub.dispose();
            }

            const updates = newMessages.filter(
                (m): m is { type: 'update'; payload: { commits: JjLogEntry[]; hasRepository?: boolean } } =>
                    typeof m === 'object' && m !== null && 'type' in m && m.type === 'update',
            );
            expect(updates).toHaveLength(1);
            expect(updates[0].payload.hasRepository).toBe(true);
            expect(updates[0].payload.commits.some((c) => c.description.includes('feat: detached repo2'))).toBe(true);

            // Disposed controller must ignore setCommits without mutating context keys or firing events
            let firedAfterDispose = false;
            controller.onDidUpdateCommits(() => {
                firedAfterDispose = true;
            });
            host.commands.contextKeys.set(JjContextKey.SelectionAllowAbandon, true);
            controller.dispose();
            controller.setCommits([]);
            expect(firedAfterDispose).toBe(false);
            expect(host.commands.contextKeys.get(JjContextKey.SelectionAllowAbandon)).toBe(true);
        } finally {
            releaseRepo2Log?.();
            controller?.dispose();
            await jjRepo1?.dispose();
            await jjRepo2?.dispose();
            await repo1?.dispose();
            await repo2?.dispose();
        }
    });
});
