/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CodeForgeProvider, GitRemote } from '../core/code-forge-provider';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { CodeForgeService } from '../core/code-forge-service';
import { EventEmitter } from '../core/host/events';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import type { CodeForgeChangeInfo, JjLogEntry } from '../core/jj-types';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

class MockProvider implements CodeForgeProvider {
    readonly changeTerm = 'Change';
    private cache = new Map<string, CodeForgeChangeInfo>();
    private emitter = new EventEmitter<void>();
    readonly onDidUpdate = this.emitter.event;
    public dispose?: () => void;
    public priority?: number;

    constructor(
        public readonly id = 'mock-provider',
        public readonly displayName = 'Mock',
        private detectResult = true,
    ) {}

    async detect(_workspaceRoot: string, _remotes: GitRemote[]): Promise<boolean> {
        return this.detectResult;
    }

    getCachedChangeInfo(changeId?: string): CodeForgeChangeInfo | undefined {
        return changeId ? this.cache.get(changeId) : undefined;
    }

    setCachedChangeInfo(changeId: string, info: CodeForgeChangeInfo) {
        this.cache.set(changeId, info);
    }

    async fetchStatuses(): Promise<boolean> {
        return false;
    }

    activate() {}
    deactivate() {}
    clearCache() {
        this.cache.clear();
    }
    fireUpdate() {
        this.emitter.fire();
    }
}

describe('CodeForgeService Tests', () => {
    let host: FakeHostEnvironment;
    let registry: CodeForgeRegistry;
    let repo1: TestRepo;
    let repo2: TestRepo;
    let jjService1: JjService;
    let jjService2: JjService;

    beforeEach(() => {
        host = new FakeHostEnvironment();
        registry = new CodeForgeRegistry();

        repo1 = new TestRepo();
        repo1.init();
        jjService1 = new JjService(repo1.path, NO_OP_LOGGER);

        repo2 = new TestRepo();
        repo2.init();
        jjService2 = new JjService(repo2.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('Each service gets a distinct provider instance with isolated cache', async () => {
        let provider1: MockProvider | undefined;
        let provider2: MockProvider | undefined;

        registry.register({
            id: 'mock-provider',
            create: () => {
                const p = new MockProvider();
                if (!provider1) {
                    provider1 = p;
                } else {
                    provider2 = p;
                }
                return p;
            },
        });

        const service1 = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        const service2 = new CodeForgeService(repo2.path, jjService2, registry, host, NO_OP_LOGGER);

        await service1.awaitReady();
        await service2.awaitReady();

        expect(provider1).toBeDefined();
        expect(provider2).toBeDefined();
        expect(provider1).not.toBe(provider2);

        // Verify cache isolation
        const info: CodeForgeChangeInfo = {
            id: 'change-1',
            number: 1,
            displayLabel: 'Change 1',
            providerName: 'Mock',
            status: 'NEW',
            submittable: true,
            url: 'http://url',
            unresolvedComments: 0,
        };

        if (provider1) {
            provider1.setCachedChangeInfo('c1', info);
        }
        expect(service1.activeProvider?.getCachedChangeInfo('c1')).toEqual(info);
        expect(service2.activeProvider?.getCachedChangeInfo('c1')).toBeUndefined();

        service1.dispose();
        service2.dispose();
    });

    test('dynamic factory registration instantiates provider and triggers detection', async () => {
        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        let factoryCreated = false;
        const dynamicProvider = new MockProvider();

        registry.register({
            id: 'dynamic-provider',
            create: () => {
                factoryCreated = true;
                return dynamicProvider;
            },
        });

        expect(factoryCreated).toBe(true);
        expect(service.getProvider('dynamic-provider')).toBe(dynamicProvider);

        service.dispose();
    });

    test('config changes trigger active provider re-detection', async () => {
        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        const detectSpy = vi.spyOn(service, 'detectActiveProvider');

        // Fire configuration change event
        host.config.set('codeForge.provider', 'mock-provider');

        expect(detectSpy).toHaveBeenCalledWith(true);

        service.dispose();
    });

    test('propagates provider update events', async () => {
        const provider = new MockProvider();
        registry.register({
            id: 'mock-provider',
            create: () => provider,
        });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        let serviceUpdated = false;
        service.onDidUpdate(() => {
            serviceUpdated = true;
        });

        // Trigger update on provider
        provider.fireUpdate();
        expect(serviceUpdated).toBe(true);

        service.dispose();
    });

    test('respects preferred provider setting during detection', async () => {
        const providerA = new MockProvider('provider-a', 'Provider A');
        const providerB = new MockProvider('provider-b', 'Provider B');

        registry.register({ id: 'provider-a', create: () => providerA });
        registry.register({ id: 'provider-b', create: () => providerB });

        // Set preferred provider setting
        host.config.set('codeForge.provider', 'provider-b');

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        // provider-b should be preferred and active
        expect(service.activeProvider).toBe(providerB);

        service.dispose();
    });

    test('prioritizes github and gitlab before gerrit during detection', async () => {
        const detectionOrder: string[] = [];
        const createTrackingProvider = (id: string) => {
            const p = new MockProvider(id, id, true);
            const origDetect = p.detect.bind(p);
            p.detect = async (root, remotes) => {
                detectionOrder.push(id);
                return origDetect(root, remotes);
            };
            return p;
        };

        const gerrit = createTrackingProvider('gerrit');
        const gitlab = createTrackingProvider('gitlab');
        const github = createTrackingProvider('github');

        // Register in arbitrary order (gerrit first)
        registry.register({ id: 'gerrit', create: () => gerrit });
        registry.register({ id: 'gitlab', create: () => gitlab });
        registry.register({ id: 'github', create: () => github });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        expect(service.activeProvider).toBe(github);
        expect(detectionOrder[0]).toBe('github');

        service.dispose();
    });

    test('populateCodeForgeInfo correctly computes sync and needsUpload statuses', async () => {
        const provider = new MockProvider();
        registry.register({ id: 'mock-provider', create: () => provider });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        const change1 = createMock<CodeForgeChangeInfo>({
            id: 'change-1',
            number: 1,
            displayLabel: 'Change 1',
            providerName: 'Mock',
            status: 'NEW',
            currentRevision: 'rev-1',
            contentSynced: true,
            parentSynced: true,
        });

        const change2 = createMock<CodeForgeChangeInfo>({
            id: 'change-2',
            number: 2,
            displayLabel: 'Change 2',
            providerName: 'Mock',
            status: 'NEW',
            currentRevision: 'rev-other', // mismatched
            contentSynced: false,
            parentSynced: true,
        });

        provider.setCachedChangeInfo('change-1', change1);
        provider.setCachedChangeInfo('change-2', change2);

        const commits: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'change-1',
                commit_id: 'rev-1',
                description: 'Commit 1',
                is_immutable: false,
                bookmarks: [],
            }),
            createMock<JjLogEntry>({
                change_id: 'change-2',
                commit_id: 'rev-2',
                description: 'Commit 2',
                is_immutable: false,
                bookmarks: [],
            }),
        ];

        service.populateCodeForgeInfo(commits);

        // Verify commit 1 is fully synced, does not need upload
        expect(commits[0].codeForgeChange).toEqual(change1);
        expect(commits[0].codeForgeNeedsUpload).toBe(false);

        // Verify commit 2 is not synced, needs upload
        expect(commits[1].codeForgeChange).toEqual(change2);
        expect(commits[1].codeForgeNeedsUpload).toBe(true);

        service.dispose();
    });

    test('CodeForgeRegistry unregistration disposable does not delete newer factory with same id', () => {
        const reg = new CodeForgeRegistry();
        const factory1 = {
            id: 'forge-x',
            create: () => new MockProvider('forge-x', 'Forge 1'),
        };
        const factory2 = {
            id: 'forge-x',
            create: () => new MockProvider('forge-x', 'Forge 2'),
        };

        const sub1 = reg.register(factory1);
        expect(reg.getFactories()).toHaveLength(1);
        expect(reg.getFactories()[0]).toBe(factory1);

        // Disposing sub1 unregisters factory1
        sub1.dispose();
        expect(reg.getFactories()).toHaveLength(0);

        // Register factory2 with same id
        const sub2 = reg.register(factory2);
        expect(reg.getFactories()).toHaveLength(1);
        expect(reg.getFactories()[0]).toBe(factory2);

        // Disposing sub1 again should NOT unregister factory2
        sub1.dispose();
        expect(reg.getFactories()).toHaveLength(1);
        expect(reg.getFactories()[0]).toBe(factory2);

        // Disposing sub2 unregisters factory2
        sub2.dispose();
        expect(reg.getFactories()).toHaveLength(0);

        reg.dispose();
    });

    test('CodeForgeService dispose is idempotent and cleans up providers and emitters', async () => {
        const mockProvider = new MockProvider('mock-disposable', 'Mock Disposable', true);
        const disposeSpy = vi.fn();
        mockProvider.dispose = disposeSpy;
        const deactivateSpy = vi.spyOn(mockProvider, 'deactivate');

        registry.register({
            id: 'mock-disposable',
            create: () => mockProvider,
        });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        expect(service.isEnabled).toBe(true);
        expect(service.activeProvider).toBe(mockProvider);

        const updateListener = vi.fn();
        const refreshListener = vi.fn();
        service.onDidUpdate(updateListener);
        service.onRequestRefresh(refreshListener);

        // First dispose
        service.dispose();

        expect(deactivateSpy).toHaveBeenCalledTimes(1);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(service.activeProvider).toBeUndefined();
        expect(service.isEnabled).toBe(false);

        // Force refresh after dispose does not fire listeners
        service.forceRefresh();
        expect(updateListener).not.toHaveBeenCalled();
        expect(refreshListener).not.toHaveBeenCalled();

        // Second dispose should be safe and idempotent
        expect(() => service.dispose()).not.toThrow();
        expect(deactivateSpy).toHaveBeenCalledTimes(1);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
    test('unlisted provider without explicit priority has lower precedence than prioritized providers', async () => {
        const unlistedProvider = new MockProvider('custom-forge', 'Custom Forge', true);
        const githubProvider = new MockProvider('github', 'GitHub', true);
        githubProvider.priority = 10;

        registry.register({ id: 'custom-forge', create: () => unlistedProvider });
        registry.register({ id: 'github', create: () => githubProvider });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        expect(service.activeProvider).toBe(githubProvider);
        service.dispose();
    });

    test('forceRefresh fires onRequestRefresh when active provider is present', async () => {
        const mockProvider = new MockProvider('mock-refresh', 'Mock Refresh', true);
        registry.register({
            id: 'mock-refresh',
            create: () => mockProvider,
        });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        const refreshListener = vi.fn();
        service.onRequestRefresh(refreshListener);

        service.forceRefresh();
        expect(refreshListener).toHaveBeenCalledTimes(1);

        service.dispose();
    });

    test('clearCache forwards call to all registered providers', async () => {
        const mockProvider1 = new MockProvider('mock-clear1', 'Mock Clear 1', true);
        const mockProvider2 = new MockProvider('mock-clear2', 'Mock Clear 2', false);
        const clearSpy1 = vi.spyOn(mockProvider1, 'clearCache');
        const clearSpy2 = vi.spyOn(mockProvider2, 'clearCache');
        registry.register({
            id: 'mock-clear1',
            create: () => mockProvider1,
        });
        registry.register({
            id: 'mock-clear2',
            create: () => mockProvider2,
        });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        service.clearCache();
        expect(clearSpy1).toHaveBeenCalledTimes(1);
        expect(clearSpy2).toHaveBeenCalledTimes(1);

        service.dispose();
    });

    test('populateCodeForgeInfo clones info objects per commit', async () => {
        const mockProvider = new MockProvider('mock-clone', 'Mock Clone', true);
        const info: CodeForgeChangeInfo = {
            id: 'shared-id',
            number: 100,
            displayLabel: 'CL 100',
            providerName: 'Mock',
            status: 'NEW',
            submittable: true,
            url: 'http://test',
            unresolvedComments: 0,
            currentRevision: 'rev-a',
        };
        mockProvider.setCachedChangeInfo('shared-id', info);

        registry.register({
            id: 'mock-clone',
            create: () => mockProvider,
        });

        const service = new CodeForgeService(repo1.path, jjService1, registry, host, NO_OP_LOGGER);
        await service.awaitReady();

        const commit1 = createMock<JjLogEntry>({
            change_id: 'shared-id',
            commit_id: 'rev-a',
            description: 'Commit A',
            bookmarks: [],
        });
        const commit2 = createMock<JjLogEntry>({
            change_id: 'shared-id',
            commit_id: 'rev-b',
            description: 'Commit B',
            bookmarks: [],
        });

        service.populateCodeForgeInfo([commit1, commit2]);

        expect(commit1.codeForgeChange).toBeDefined();
        expect(commit2.codeForgeChange).toBeDefined();
        expect(commit1.codeForgeChange).not.toBe(commit2.codeForgeChange);
        expect(commit1.codeForgeChange).not.toBe(info);

        service.dispose();
    });
});

describe('CodeForgeService polling and throttling', () => {
    let host: FakeHostEnvironment;
    let repo: TestRepo;
    let provider: MockProvider;
    let service: CodeForgeService;
    let refreshRequests: number;

    beforeEach(async () => {
        host = new FakeHostEnvironment();
        repo = new TestRepo();
        repo.init();
        provider = new MockProvider();
        const registry = new CodeForgeRegistry();
        registry.register({ id: 'mock-provider', create: () => provider });

        service = new CodeForgeService(repo.path, new JjService(repo.path, NO_OP_LOGGER), registry, host, NO_OP_LOGGER);
        await service.awaitReady();
        expect(service.isEnabled).toBe(true);

        refreshRequests = 0;
        service.onRequestRefresh(() => {
            refreshRequests++;
        });
        vi.useFakeTimers();
    });

    afterEach(() => {
        service.dispose();
        vi.useRealTimers();
    });

    describe('codeForge.pollIntervalSeconds', () => {
        test('defaults to polling every 60 seconds', () => {
            service.startPolling();

            vi.advanceTimersByTime(59_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);
            expect(refreshRequests).toBe(1);
            vi.advanceTimersByTime(60_000);
            expect(refreshRequests).toBe(2);
        });

        test('honours a custom interval', () => {
            host.config.set('codeForge.pollIntervalSeconds', 300);
            service.startPolling();

            vi.advanceTimersByTime(299_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);
            expect(refreshRequests).toBe(1);
        });

        test('startPolling is idempotent and does not restart the countdown', () => {
            service.startPolling();
            vi.advanceTimersByTime(30_000);
            service.startPolling();
            vi.advanceTimersByTime(30_000);

            expect(refreshRequests).toBe(1);
        });

        test('0 disables polling', () => {
            host.config.set('codeForge.pollIntervalSeconds', 0);
            service.startPolling();

            vi.advanceTimersByTime(24 * 60 * 60_000);
            expect(refreshRequests).toBe(0);
        });

        test('raises small intervals to a 10 second floor', () => {
            host.config.set('codeForge.pollIntervalSeconds', 1);
            service.startPolling();

            vi.advanceTimersByTime(9_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);
            expect(refreshRequests).toBe(1);
        });

        test('falls back to the default for values that are not numbers', () => {
            host.config.set<unknown>('codeForge.pollIntervalSeconds', 'soon');
            service.startPolling();

            vi.advanceTimersByTime(59_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);
            expect(refreshRequests).toBe(1);
        });

        test('does not let a huge interval overflow the timer into firing immediately', () => {
            host.config.set('codeForge.pollIntervalSeconds', 1e12);
            service.startPolling();

            vi.advanceTimersByTime(60 * 60_000);
            expect(refreshRequests).toBe(0);
        });

        test('reschedules a running poller when the setting changes', () => {
            service.startPolling();
            vi.advanceTimersByTime(30_000);

            host.config.set('codeForge.pollIntervalSeconds', 20);
            vi.advanceTimersByTime(19_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);
            expect(refreshRequests).toBe(1);
            vi.advanceTimersByTime(20_000);
            expect(refreshRequests).toBe(2);
        });

        test('re-enabling polling at runtime starts the poller', () => {
            host.config.set('codeForge.pollIntervalSeconds', 0);
            service.startPolling();
            vi.advanceTimersByTime(10 * 60_000);
            expect(refreshRequests).toBe(0);

            host.config.set('codeForge.pollIntervalSeconds', 30);
            vi.advanceTimersByTime(30_000);
            expect(refreshRequests).toBe(1);
        });

        test('disabling polling at runtime stops a running poller', () => {
            service.startPolling();
            host.config.set('codeForge.pollIntervalSeconds', 0);

            vi.advanceTimersByTime(10 * 60_000);
            expect(refreshRequests).toBe(0);
        });

        test('a setting change does not start polling that was never requested', () => {
            host.config.set('codeForge.pollIntervalSeconds', 20);

            vi.advanceTimersByTime(10 * 60_000);
            expect(refreshRequests).toBe(0);
        });

        test('stopPolling stops the poller and later setting changes do not restart it', () => {
            service.startPolling();
            service.stopPolling();
            host.config.set('codeForge.pollIntervalSeconds', 20);

            vi.advanceTimersByTime(10 * 60_000);
            expect(refreshRequests).toBe(0);
        });

        test('skips ticks while the window is inactive', () => {
            service.startPolling();
            host.ui.isActive = false;
            vi.advanceTimersByTime(60_000);
            expect(refreshRequests).toBe(0);

            host.ui.isActive = true;
            vi.advanceTimersByTime(60_000);
            expect(refreshRequests).toBe(1);
        });

        test('dispose stops polling', () => {
            service.startPolling();
            service.dispose();

            vi.advanceTimersByTime(10 * 60_000);
            expect(refreshRequests).toBe(0);
        });

        test('changing an unrelated codeForge setting does not re-detect the provider', () => {
            const detectSpy = vi.spyOn(service, 'detectActiveProvider');
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            host.config.set('codeForge.pollIntervalSeconds', 30);

            expect(detectSpy).not.toHaveBeenCalled();
        });
    });

    describe('codeForge.minRefreshIntervalSeconds', () => {
        test('never throttles by default', async () => {
            await service.ensureFreshStatuses([]);

            expect(service.isWithinMinRefreshInterval()).toBe(false);
        });

        test('does not throttle before the first fetch', () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);

            expect(service.isWithinMinRefreshInterval()).toBe(false);
        });

        test('throttles until the interval has elapsed since the last fetch', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);

            expect(service.isWithinMinRefreshInterval()).toBe(true);
            vi.advanceTimersByTime(29_999);
            expect(service.isWithinMinRefreshInterval()).toBe(true);
            vi.advanceTimersByTime(1);
            expect(service.isWithinMinRefreshInterval()).toBe(false);
        });

        test('a new fetch restarts the window', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            vi.advanceTimersByTime(30_000);
            await service.ensureFreshStatuses([]);

            vi.advanceTimersByTime(29_999);
            expect(service.isWithinMinRefreshInterval()).toBe(true);
        });

        test('a failed fetch still starts the window', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            vi.spyOn(provider, 'fetchStatuses').mockRejectedValue(new Error('rate limited'));

            await expect(service.ensureFreshStatuses([])).rejects.toThrow('rate limited');

            expect(service.isWithinMinRefreshInterval()).toBe(true);
        });

        test('clearCache resets the window', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);

            service.clearCache();

            expect(service.isWithinMinRefreshInterval()).toBe(false);
        });

        test('changing the active provider resets the window', async () => {
            const other = new MockProvider('other-provider', 'Other');
            const registry = new CodeForgeRegistry();
            registry.register({ id: 'mock-provider', create: () => provider });
            registry.register({ id: 'other-provider', create: () => other });
            const multiService = new CodeForgeService(
                repo.path,
                new JjService(repo.path, NO_OP_LOGGER),
                registry,
                host,
                NO_OP_LOGGER,
            );
            vi.useRealTimers();
            await multiService.awaitReady();
            vi.useFakeTimers();

            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await multiService.ensureFreshStatuses([]);
            expect(multiService.isWithinMinRefreshInterval()).toBe(true);

            host.config.set('codeForge.provider', 'other-provider');
            vi.useRealTimers();
            await multiService.detectActiveProvider(true);
            vi.useFakeTimers();

            expect(multiService.activeProvider).toBe(other);
            expect(multiService.isWithinMinRefreshInterval()).toBe(false);
            multiService.dispose();
        });

        test.each<unknown>([0, -5, Number.NaN, 'abc'])('treats %s as no throttling', async (value) => {
            host.config.set<unknown>('codeForge.minRefreshIntervalSeconds', value);
            await service.ensureFreshStatuses([]);

            expect(service.isWithinMinRefreshInterval()).toBe(false);
        });

        test('is unaffected by the clock moving backwards', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);

            vi.setSystemTime(Date.now() - 60 * 60_000);

            expect(service.isWithinMinRefreshInterval()).toBe(false);
        });
    });

    describe('scheduleDeferredRefresh', () => {
        test('requests a refresh when the throttle window ends', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            vi.advanceTimersByTime(10_000);

            service.scheduleDeferredRefresh();
            vi.advanceTimersByTime(19_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);
            expect(refreshRequests).toBe(1);

            vi.advanceTimersByTime(10 * 60_000);
            expect(refreshRequests).toBe(1);
        });

        test('coalesces repeated requests into a single refresh', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);

            for (let i = 0; i < 5; i++) {
                service.scheduleDeferredRefresh();
                vi.advanceTimersByTime(1_000);
            }
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(60_000);

            expect(refreshRequests).toBe(1);
        });

        test('can be requested again once the previous deferral has fired', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            service.scheduleDeferredRefresh();
            vi.advanceTimersByTime(30_000);
            expect(refreshRequests).toBe(1);

            await service.ensureFreshStatuses([]);
            service.scheduleDeferredRefresh();
            vi.advanceTimersByTime(30_000);
            expect(refreshRequests).toBe(2);
        });

        test('still fires after an intervening fetch, which may have failed or done nothing', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            vi.advanceTimersByTime(5_000);
            service.scheduleDeferredRefresh();

            // The second fetch pushes the end of the window from t=30s to t=40s.
            vi.advanceTimersByTime(5_000);
            await service.ensureFreshStatuses([]);
            vi.advanceTimersByTime(29_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);

            expect(refreshRequests).toBe(1);
        });

        test('re-arms against a lowered minRefreshIntervalSeconds', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 300);
            await service.ensureFreshStatuses([]);
            service.scheduleDeferredRefresh();

            host.config.set('codeForge.minRefreshIntervalSeconds', 5);
            vi.advanceTimersByTime(4_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);

            expect(refreshRequests).toBe(1);
        });

        test('re-arms against a raised minRefreshIntervalSeconds', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            vi.advanceTimersByTime(10_000);
            service.scheduleDeferredRefresh();

            host.config.set('codeForge.minRefreshIntervalSeconds', 60);
            vi.advanceTimersByTime(49_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);

            expect(refreshRequests).toBe(1);
        });

        test('turning throttling off fires a pending refresh straight away', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 300);
            await service.ensureFreshStatuses([]);
            service.scheduleDeferredRefresh();

            host.config.set('codeForge.minRefreshIntervalSeconds', 0);
            vi.advanceTimersByTime(1);

            expect(refreshRequests).toBe(1);
        });

        test('changing minRefreshIntervalSeconds with nothing pending arms no timer', () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 5);

            expect(vi.getTimerCount()).toBe(0);
        });

        test('waits out a window extended by a fetch that was already in flight at the request', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            vi.advanceTimersByTime(5_000);

            let finishFetch!: (changed: boolean) => void;
            vi.spyOn(provider, 'fetchStatuses').mockImplementationOnce(
                () =>
                    new Promise<boolean>((resolve) => {
                        finishFetch = resolve;
                    }),
            );
            const inFlight = service.ensureFreshStatuses([]);
            service.scheduleDeferredRefresh();

            // It ends at t=15s, moving the window end from t=30s to t=45s.
            vi.advanceTimersByTime(10_000);
            finishFetch(false);
            await inFlight;

            vi.advanceTimersByTime(29_999);
            expect(refreshRequests).toBe(0);
            vi.advanceTimersByTime(1);
            expect(refreshRequests).toBe(1);
        });

        test('is dropped while the window is inactive', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            service.scheduleDeferredRefresh();

            host.ui.isActive = false;
            vi.advanceTimersByTime(10 * 60_000);

            expect(refreshRequests).toBe(0);
        });

        test('fires on the next tick when throttling is off', () => {
            service.scheduleDeferredRefresh();

            vi.advanceTimersByTime(1);

            expect(refreshRequests).toBe(1);
        });

        test('does not let a huge interval overflow the timer into firing immediately', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 1e12);
            await service.ensureFreshStatuses([]);
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            service.scheduleDeferredRefresh();

            // An overflowing delay would fire after ~1ms and re-arm in a loop.
            vi.advanceTimersByTime(1_000);

            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            expect(refreshRequests).toBe(0);
        });

        test('is cancelled by dispose', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            service.scheduleDeferredRefresh();

            service.dispose();
            vi.advanceTimersByTime(10 * 60_000);

            expect(refreshRequests).toBe(0);
        });

        test('is ignored after dispose', async () => {
            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await service.ensureFreshStatuses([]);
            service.dispose();

            service.scheduleDeferredRefresh();
            vi.advanceTimersByTime(10 * 60_000);

            expect(refreshRequests).toBe(0);
        });

        test('is cancelled when the active provider changes', async () => {
            // Real I/O drives provider detection, so fake only the clock and timeouts, from the start.
            vi.useRealTimers();
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            const other = new MockProvider('other-provider', 'Other');
            const registry = new CodeForgeRegistry();
            registry.register({ id: 'mock-provider', create: () => provider });
            registry.register({ id: 'other-provider', create: () => other });
            const multiService = new CodeForgeService(
                repo.path,
                new JjService(repo.path, NO_OP_LOGGER),
                registry,
                host,
                NO_OP_LOGGER,
            );
            await multiService.awaitReady();
            const forceRefreshSpy = vi.spyOn(multiService, 'forceRefresh');

            host.config.set('codeForge.minRefreshIntervalSeconds', 30);
            await multiService.ensureFreshStatuses([]);
            multiService.scheduleDeferredRefresh();

            host.config.set('codeForge.provider', 'other-provider');
            await multiService.detectActiveProvider(true);
            vi.advanceTimersByTime(10 * 60_000);

            expect(multiService.activeProvider).toBe(other);
            expect(forceRefreshSpy).not.toHaveBeenCalled();
            multiService.dispose();
        });
    });
});
