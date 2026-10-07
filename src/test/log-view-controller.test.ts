/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeProvider } from '../core/code-forge-provider';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { MANUAL_REFRESH_REASON } from '../core/code-forge-service';
import { LogViewController } from '../core/controllers/log-view-controller';
import { EventEmitter } from '../core/host/events';
import { JjContextKey } from '../core/jj-context-keys';
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
        vi.useRealTimers();
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

    describe('code forge fetch throttling (codeForge.minRefreshIntervalSeconds)', () => {
        async function setUpCodeForge() {
            const repo = repositoryManager.getRepositoryForUri(Uri.file(testRepo.path));
            if (!repo) {
                throw new Error('Repository not registered in test');
            }
            const fetchStatuses = vi.fn().mockResolvedValue(false);
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
        async function waitForFetchCount(fetchStatuses: ReturnType<typeof vi.fn>, count: number) {
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
            const jj = controller.jj;
            if (!jj) {
                throw new Error('Controller has no jj service');
            }
            vi.spyOn(jj, 'getLog').mockResolvedValueOnce([
                createMock<JjLogEntry>({
                    change_id: 'newer-change',
                    commit_id: 'newer-commit',
                    description: 'newer',
                    is_immutable: false,
                    is_empty: false,
                    conflict: false,
                    bookmarks: [],
                    tags: [],
                    parents: [],
                }),
            ]);
            await controller.refresh('fileChange');
            expect(fetchStatuses).toHaveBeenCalledTimes(2);

            // The deferred refresh fires while the slow fetch runs; a further fetch must then cover the new commit.
            await vi.advanceTimersByTimeAsync(30_000);
            finishFetch(false);
            await waitForFetchCount(fetchStatuses, 3);

            const lastChanges = fetchStatuses.mock.calls[2][0] as { changeId: string }[];
            expect(lastChanges.map((c) => c.changeId)).toContain('newer-change');
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

            const jj = controller.jj;
            if (!jj) {
                throw new Error('Controller has no jj service');
            }
            vi.spyOn(jj, 'getLog').mockRejectedValueOnce(new Error('transient jj failure'));
            await controller.refresh(MANUAL_REFRESH_REASON);
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
            await new Promise((resolve) => setTimeout(resolve, 100));

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
    });
});
