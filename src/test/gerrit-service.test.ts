/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'; // Vitest
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GerritService } from '../gerrit-service';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';
import { FakeGerritServer } from './fake-gerrit-server';

// Mock VS Code
const mockConfig = {
    get: vi.fn(),
};

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => mockConfig,
        onDidChangeConfiguration: vi.fn(),
    },
    Disposable: { from: vi.fn() },
    EventEmitter: class {
        private listeners: Function[] = [];
        event = (listener: Function) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
        fire = (data: unknown) => {
            this.listeners.forEach(l => l(data));
        };
        dispose = vi.fn();
    },
    window: {
        state: { focused: true },
        onDidChangeWindowState: vi.fn(),
    },
}));

describe('GerritService Detection', () => {
    let repo: TestRepo;
    let service: GerritService;
    let jjService: JjService;
    let mockOnDidChangeWindowState: ReturnType<typeof vi.fn>;
    let fakeGerritServer: FakeGerritServer;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        mockConfig.get.mockReset();
        
        mockOnDidChangeWindowState = vscode.window.onDidChangeWindowState as unknown as ReturnType<typeof vi.fn>;
        mockOnDidChangeWindowState.mockReset();
        mockOnDidChangeWindowState.mockReturnValue({ dispose: vi.fn() });

        jjService = new JjService(repo.path);
        fakeGerritServer = new FakeGerritServer();
        
        // Default fetch mock using FakeGerrit
        global.fetch = vi.fn().mockImplementation((url, init) => {
             return fakeGerritServer.handleFetch(url, init);
        }) as unknown as typeof fetch;
    });

    afterEach(async () => {
        if (service) {
            service.dispose();
        }
        repo.dispose();
        vi.clearAllMocks(); // This clears the mock history and implementation? Yes.
    });

    // Helper to access private property without using 'any'
    function getGerritHost(srv: GerritService): string | undefined {
        return (srv as unknown as { _gerritHost: string | undefined })._gerritHost;
    }

    test('Detects from extension setting (highest priority)', async () => {
        mockConfig.get.mockImplementation((key: string) => {
            if (key === 'gerrit.host') return 'https://setting-host.com';
            return undefined;
        });

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        expect(service.isEnabled).toBe(true);
        expect(getGerritHost(service)).toBe('https://setting-host.com');
    });

    test('Detects from .gitreview file (secondary priority)', async () => {
        const gitreviewPath = path.join(repo.path, '.gitreview');
        await fs.promises.writeFile(gitreviewPath, '[gerrit]\nhost=gitreview-host.com\n');

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        expect(getGerritHost(service)).toBe('https://gitreview-host.com');
    });

    test('Detects from googlesource.com remote', async () => {
        repo.addRemote('origin', 'https://chromium.googlesource.com/chromium/src.git');

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // Should convert to -review and strip path
        expect(getGerritHost(service)).toBe('https://chromium-review.googlesource.com');
    });

    test('Detects from remote with existing -review.googlesource.com', async () => {
        repo.addRemote('origin', 'https://chromium-review.googlesource.com/chromium/src');

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        expect(getGerritHost(service)).toBe('https://chromium-review.googlesource.com');
    });

    test('Detects from remote with /gerrit/ path', async () => {
        repo.addRemote('origin', 'https://git.eclipse.org/gerrit/p/platform.git');

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // existing logic for non-googlesource just does replace .git and ensures https.
        expect(getGerritHost(service)).toBe('https://git.eclipse.org/gerrit/p/platform');
    });

    test('Handles ssh remote format', async () => {
         repo.addRemote('origin', 'ssh://user@gerrit.googlesource.com:29418/repo');
 
         service = new GerritService(repo.path, jjService);
         await service.awaitReady();
 
         // Should strip repo path
         expect(getGerritHost(service)).toBe('https://gerrit-review.googlesource.com');
    });

    test('Detects from sso:// remote', async () => {
        repo.addRemote('origin', 'sso://chromium/chromium/src.git');

        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        expect(getGerritHost(service)).toBe('https://chromium-review.googlesource.com');
    });

    test('fetchAndCacheStatus prioritizes Description Change-Id', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 123,
            status: 'NEW'
        });

        const result = await service.fetchAndCacheStatus('commit-sha', 'z-change-id', 'Description\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678\n');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining(`change:${changeId}`)
        );
        expect(result?.changeId).toBe('I1234567890abcdef1234567890abcdef12345678');
    });

    test('fetchAndCacheStatus falls back to Computed Change-Id', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I000000000000ffffffffffffffffffffffffffff';
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 456,
            status: 'NEW'
        });

        // z (122) -> 0
        // k (107) -> f
        // "zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk" -> "000000000000ffffffffffffffffffffffffffff" (32 chars)
        const jjId = 'zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk'; 
        
        const result = await service.fetchAndCacheStatus('commit-sha', jjId, 'Description without ID');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining(`change:${changeId}`)
        );
        expect(result?.changeNumber).toBe(456);
    });

    test('fetchAndCacheStatus ignores commit SHA if Change-Id logic fails (or just returns undefined)', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // Should not be called
        const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
        fetchSpy.mockClear();

        const result = await service.fetchAndCacheStatus('commit-sha', undefined, 'Description without ID');

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
    });
    test('fetchAndCacheStatus handles invalid JJ Change-Id gracefully', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // should trigger the try-catch block
        const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
        fetchSpy.mockClear();

        // 'a' is not a valid char in k-z range
        // This should trigger the try-catch block in fetchClStatus
        const result = await service.fetchAndCacheStatus('commit-sha', 'invalid-id-a', 'Description without ID');

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
    });
    test('fetchAndCacheStatus caches by Change-Id', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 123,
            status: 'NEW'
        });

        // First call
        await service.fetchAndCacheStatus('commit-1', 'change-1', `Desc\n\nChange-Id: ${changeId}`);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // Second call with DIFFERENT commit ID but SAME Change-Id - should use cache
        await service.fetchAndCacheStatus('commit-2', 'change-1', `Desc\n\nChange-Id: ${changeId}`);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('forceFetchAndCacheStatus bypasses cache and updates it', async () => {
        mockConfig.get.mockImplementation((key: string) => key === 'gerrit.host' ? 'https://host.com' : undefined);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // Pre-populate gerrit server
        const cacheKey = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey,
            status: 'NEW',
            _number: 123
        });
        
        // Cache it first
        await service.fetchAndCacheStatus('c1', 'change-1', `Change-Id: ${cacheKey}`);
        
        // Now update it on server (but we want to verifying cache BYPASS, so updating server and force refreshing should show update)
        fakeGerritServer.updateChange(cacheKey, { status: 'MERGED' });

        const result = await service.forceFetchAndCacheStatus('c1', 'change-1', `Change-Id: ${cacheKey}`);
        
        expect(result?.status).toBe('MERGED');
    });
    
    test('ensureFreshStatuses detects changes', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // 1. Setup Cache with OLD data
        const cacheKey = 'I1234567890abcdef1234567890abcdef12345678';
        // 1. Setup Gerrit with OLD data and cache it
        // 1. Setup Gerrit with OLD data and cache it
        const cacheKey1 = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey1,
            status: 'NEW',
            _number: 123
        });
        await service.fetchAndCacheStatus('commit-1', 'change-1', `Change-Id: ${cacheKey1}`);
        fakeGerritServer.addChange({
            change_id: cacheKey,
            status: 'NEW',
            _number: 123
        });
        await service.fetchAndCacheStatus('commit-1', 'change-1', `Change-Id: ${cacheKey1}`);

        // 2. Update Gerrit with NEW data (MERGED)
        fakeGerritServer.updateChange(cacheKey1, { status: 'MERGED', submittable: false });

        const items = [{
            commitId: 'commit-1',
            changeId: 'change-1',
            description: `Change-Id: ${cacheKey1}`
        }];

        const hasChanges = await service.ensureFreshStatuses(items);

        expect(hasChanges).toBe(true);
        expect(service.getCachedClStatus(undefined, `Change-Id: ${cacheKey1}`)?.status).toBe('MERGED');
    });

    test('ensureFreshStatuses returns false if no changes', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // 1. Setup Gerrit and Cache
        const cacheKey3 = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey3,
            status: 'NEW',
            _number: 123
        });
        await service.fetchAndCacheStatus('commit-1', 'change-1', `Change-Id: ${cacheKey3}`);

        // 2. No updates to Gerrit (still NEW)

        const items3 = [{
            commitId: 'commit-1',
            changeId: 'change-1',
            description: `Change-Id: ${cacheKey3}`
        }];

        const hasChanges3 = await service.ensureFreshStatuses(items3);

        expect(hasChanges3).toBe(false);
    });

    test('startPolling clears cache and fires onDidUpdate', async () => {
        vi.useFakeTimers();
        
        mockConfig.get.mockImplementation((key: string) => key === 'gerrit.host' ? 'https://host.com' : undefined);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();
        expect(service.isEnabled).toBe(true);

        // Pre-populate gerrit
        const cacheKey = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey,
            status: 'NEW',
            _number: 123
        });
        await service.fetchAndCacheStatus('c1', 'change-1', `Change-Id: ${cacheKey}`);
        
        // Verify it's cached
        expect(service.getCachedClStatus(undefined, `Change-Id: ${cacheKey}`)).toBeDefined();

        // Track onDidUpdate calls
        let updateFired = false;
        const disposable = service.onDidUpdate(() => { updateFired = true; });

        // Start polling
        service.startPolling();

        // Advance past the polling interval (60 seconds)
        await vi.advanceTimersByTimeAsync(60_000);

        // onDidUpdate should have been fired to notify listeners to re-fetch
        expect(updateFired).toBe(true);
        disposable.dispose();

        vi.useRealTimers();
    });

    test('forceRefresh clears cache and fires onDidUpdate', async () => {
        mockConfig.get.mockImplementation((key: string) => key === 'gerrit.host' ? 'https://host.com' : undefined);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();
        expect(service.isEnabled).toBe(true);

        // Pre-populate gerrit
        const cacheKey = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey,
            status: 'NEW',
            _number: 123
        });
        await service.fetchAndCacheStatus('c1', 'change-1', `Change-Id: ${cacheKey}`);

        // Verify it's cached
        expect(service.getCachedClStatus(undefined, `Change-Id: ${cacheKey}`)).toBeDefined();

        // Track onDidUpdate calls
        let updateFired = false;
        const disposable = service.onDidUpdate(() => { updateFired = true; });

        service.forceRefresh();

        expect(updateFired).toBe(true);
        disposable.dispose();
    });

    test('fetchAndCacheStatus parses changed files', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I1234567890abcdef1234567890abcdef12345678';
        const currentRev = 'commit-sha-on-gerrit';
        
        fakeGerritServer.addChange({
            change_id: changeId,
            status: 'NEW',
            _number: 123,
            current_revision: currentRev,
            revisions: {
                [currentRev]: {
                    files: {
                        'file1.txt': { status: 'M', new_sha: 'abc' },
                        'file2.txt': { status: 'A', new_sha: 'def' },
                        'deleted.txt': { status: 'D' },
                        '/COMMIT_MSG': { status: 'A' }
                    }
                }
            }
        });

        const result = await service.fetchAndCacheStatus('local-sha', changeId, `Change-Id: ${changeId}`);

        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('o=CURRENT_FILES'));
        expect(result?.files).toBeDefined();
        expect(result?.files?.['file1.txt']).toEqual({ status: 'M', newSha: 'abc' });
        expect(result?.files?.['file2.txt']).toEqual({ status: 'A', newSha: 'def' });
        // Deleted file has no newSha
        expect(result?.files?.['deleted.txt']).toEqual({ status: 'D', newSha: undefined });
        // Magic file should be filtered out
        expect(result?.files?.['/COMMIT_MSG']).toBeUndefined();
    });

    test('fetchAndCacheStatus detects extra local files as not synced', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // 1. Create a commit with 2 files locally
        repo.writeFile('file1.txt', 'content1');
        repo.writeFile('file2.txt', 'content2');
        await jjService.describe('commit with 2 files');
        
        // Get commit ID of @ (which has the files)
        const commitId = repo.getCommitId('@').trim();
        const changeId = 'I1234567890abcdef1234567890abcdef12345678'; 

        // 2. Mock Gerrit response knowing ONLY about file1.txt
        const currentRev = 'commit-sha-on-gerrit';
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 123,
            status: 'NEW',
            current_revision: currentRev,
            revisions: {
                [currentRev]: {
                    files: {
                        'file1.txt': { status: 'A', new_sha: 'abc' }
                    }
                }
            }
        });

        // 3. Trigger fetch
        const result = await service.fetchAndCacheStatus(commitId, changeId, `Change-Id: ${changeId}`);

        // 4. Verify
        expect(global.fetch).toHaveBeenCalled();
        expect(result).toBeDefined();
        // Should be not synced because file2.txt is extra locally
        expect(result?.synced).toBeFalsy();
    });

    test('requestRefreshWithBackoffs schedules multiple refreshes', async () => {
        vi.useFakeTimers();
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const forceRefreshSpy = vi.spyOn(service, 'forceRefresh');
        
        // Mock scheduler to verify delays
        const scheduler = vi.fn().mockImplementation((fn, delay) => {
            setTimeout(fn, delay);
        });

        service.requestRefreshWithBackoffs(scheduler);

        expect(scheduler).toHaveBeenCalledTimes(4);
        expect(scheduler).toHaveBeenCalledWith(expect.any(Function), 2000);
        expect(scheduler).toHaveBeenCalledWith(expect.any(Function), 3000);
        expect(scheduler).toHaveBeenCalledWith(expect.any(Function), 5000);
        expect(scheduler).toHaveBeenCalledWith(expect.any(Function), 10000);

        // Advance time to trigger all refreshes
        await vi.advanceTimersByTimeAsync(10000);
        expect(forceRefreshSpy).toHaveBeenCalledTimes(4);

        vi.useRealTimers();
    });

    test('refreshes on window focus with throttling', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(20000); // Start at t=20s to ensure throttling logic works (20000 > 10000)

        // Setup to be enabled
        mockConfig.get.mockImplementation((key: string) => key === 'gerrit.host' ? 'https://host.com' : undefined);

        // Initialize service
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // Spy on _onDidUpdate.fire to verify refreshes
        let updateCount = 0;
        const disposable = service.onDidUpdate(() => { updateCount++; });

        // Check listener registration
        expect(mockOnDidChangeWindowState).toHaveBeenCalled();
        const listener = mockOnDidChangeWindowState.mock.calls[0][0];

        // 1. Trigger focus (should refresh)
        listener({ focused: true });
        expect(updateCount).toBe(1);

        // 2. Trigger focus again immediately (should be throttled)
        listener({ focused: true });
        expect(updateCount).toBe(1);

        // 3. Advance time by 5s (still throttled)
        await vi.advanceTimersByTimeAsync(5000);
        listener({ focused: true });
        expect(updateCount).toBe(1);

        // 4. Advance time by another 6s (total 11s > 10s) -> Should refresh
        await vi.advanceTimersByTimeAsync(6000);
        listener({ focused: true });
        expect(updateCount).toBe(2);

        // 5. Blur event (should NOT refresh)
        listener({ focused: false });
        expect(updateCount).toBe(2);
        
        disposable.dispose();

        vi.useRealTimers();
    });
});
