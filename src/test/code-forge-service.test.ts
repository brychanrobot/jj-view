/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// sort-imports-ignore

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { NO_OP_LOGGER } from '../jj-service';
import { FakeConfigStore } from './test-utils';

const fakeConfigStore = new FakeConfigStore();
let mockConfigListener: ((e: { affectsConfiguration(section: string): boolean }) => void) | undefined;
let mockWindowStateListener: ((e: { focused: boolean }) => void) | undefined;

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock({
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/root' } }],
            getConfiguration: () => fakeConfigStore.toWorkspaceConfiguration(),
            onDidChangeConfiguration: vi.fn().mockImplementation((listener) => {
                mockConfigListener = listener;
                return { dispose: vi.fn() };
            }),
        },
        window: {
            state: { focused: true },
            onDidChangeWindowState: vi.fn().mockImplementation((listener) => {
                mockWindowStateListener = listener;
                return { dispose: vi.fn() };
            }),
        },
    });
});

import type { CodeForgeProvider, GitRemote } from '../code-forge-provider';
import { CodeForgeRegistry } from '../code-forge-registry';
import { CodeForgeService } from '../code-forge-service';
import { JjService } from '../jj-service';
import type { CodeForgeChangeInfo, JjLogEntry } from '../jj-types';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

class MockProvider implements CodeForgeProvider {
    readonly changeTerm = 'Change';
    private cache = new Map<string, CodeForgeChangeInfo>();
    private emitter = new vscode.EventEmitter<void>();
    readonly onDidUpdate = this.emitter.event;

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
    let registry: CodeForgeRegistry;
    let repo1: TestRepo;
    let repo2: TestRepo;
    let jjService1: JjService;
    let jjService2: JjService;

    beforeEach(() => {
        fakeConfigStore.clear();
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

        const service1 = new CodeForgeService(repo1.path, jjService1, registry);
        const service2 = new CodeForgeService(repo2.path, jjService2, registry);

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
        const service = new CodeForgeService(repo1.path, jjService1, registry);
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
        const service = new CodeForgeService(repo1.path, jjService1, registry);
        await service.awaitReady();

        const detectSpy = vi.spyOn(service, 'detectActiveProvider');

        // Fire configuration change event
        if (mockConfigListener) {
            mockConfigListener({
                affectsConfiguration: (section: string) => section === 'jj-view.codeForge',
            });
        }

        expect(detectSpy).toHaveBeenCalledWith(true);

        service.dispose();
    });

    test('window focus triggers throttled refresh if enabled', async () => {
        vi.useFakeTimers();

        const provider = new MockProvider();
        registry.register({
            id: 'mock-provider',
            create: () => provider,
        });

        const service = new CodeForgeService(repo1.path, jjService1, registry);
        await service.awaitReady();

        // Must be enabled (have an active provider)
        expect(service.isEnabled).toBe(true);

        const refreshSpy = vi.spyOn(service, 'forceRefresh');

        // Gaining focus should trigger refresh
        if (mockWindowStateListener) {
            mockWindowStateListener({ focused: true });
        }
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        // Instant focus again should NOT trigger refresh (throttled to 10s)
        if (mockWindowStateListener) {
            mockWindowStateListener({ focused: true });
        }
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        // Advance timers by 11 seconds to bypass throttle
        await vi.advanceTimersByTimeAsync(11000);
        if (mockWindowStateListener) {
            mockWindowStateListener({ focused: true });
        }
        expect(refreshSpy).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
        service.dispose();
    });

    test('propagates provider update events', async () => {
        const provider = new MockProvider();
        registry.register({
            id: 'mock-provider',
            create: () => provider,
        });

        const service = new CodeForgeService(repo1.path, jjService1, registry);
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
        fakeConfigStore.set('codeForge.provider', 'provider-b');

        const service = new CodeForgeService(repo1.path, jjService1, registry);
        await service.awaitReady();

        // provider-b should be preferred and active
        expect(service.activeProvider).toBe(providerB);

        // Reset preferred setting
        fakeConfigStore.clear();

        service.dispose();
    });

    test('populateCodeForgeInfo correctly computes sync and needsUpload statuses', async () => {
        const provider = new MockProvider();
        registry.register({ id: 'mock-provider', create: () => provider });

        const service = new CodeForgeService(repo1.path, jjService1, registry);
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
});
