/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'; // Vitest
import * as path from 'path';
import * as fs from 'fs';
import { GerritService } from '../gerrit-service';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';

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
        event = vi.fn();
        fire = vi.fn();
        dispose = vi.fn();
    },
    window: { state: { focused: true } },
}));

describe('GerritService Detection', () => {
    let repo: TestRepo;
    let service: GerritService;
    let jjService: JjService;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        mockConfig.get.mockReset();

        jjService = new JjService(repo.path);
        
        // Default fetch mock for probing
        global.fetch = vi.fn().mockImplementation((url) => {
             // Allow probing to succeed for any 'config/server/version' check or 'git.eclipse.org' (which might be checked via /changes/?n=1 or similar if I implemented that fallback, but I didn't)
             if (url && typeof url === 'string' && (url.includes('/config/server/version'))) {
                 return Promise.resolve({ ok: true });
             }
             // Fail others by default
             return Promise.resolve({ ok: false });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;
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
        
        // Wait for async detection
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(service.isEnabled).toBe(true);
        expect(getGerritHost(service)).toBe('https://setting-host.com');
    });

    test('Detects from .gitreview file (secondary priority)', async () => {
        const gitreviewPath = path.join(repo.path, '.gitreview');
        await fs.promises.writeFile(gitreviewPath, '[gerrit]\nhost=gitreview-host.com\n');

        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(getGerritHost(service)).toBe('https://gitreview-host.com');
    });

    test('Detects from googlesource.com remote', async () => {
        repo.addRemote('origin', 'https://chromium.googlesource.com/chromium/src.git');

        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 200));

        // Should convert to -review and strip path
        expect(getGerritHost(service)).toBe('https://chromium-review.googlesource.com');
    });

    test('Detects from remote with existing -review.googlesource.com', async () => {
        repo.addRemote('origin', 'https://chromium-review.googlesource.com/chromium/src');

        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(getGerritHost(service)).toBe('https://chromium-review.googlesource.com');
    });

    test('Detects from remote with /gerrit/ path', async () => {
        repo.addRemote('origin', 'https://git.eclipse.org/gerrit/p/platform.git');

        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 200));

        // existing logic for non-googlesource just does replace .git and ensures https.
        expect(getGerritHost(service)).toBe('https://git.eclipse.org/gerrit/p/platform');
    });

    test('Handles ssh remote format', async () => {
         repo.addRemote('origin', 'ssh://user@gerrit.googlesource.com:29418/repo');
 
         service = new GerritService(repo.path, jjService);
         await new Promise(resolve => setTimeout(resolve, 200));
 
         // Should strip repo path
         expect(getGerritHost(service)).toBe('https://gerrit-review.googlesource.com');
    });

    test('Detects from sso:// remote', async () => {
        repo.addRemote('origin', 'sso://chromium/chromium/src.git');

        // Mock probe to succeed
        global.fetch = vi.fn().mockImplementation((url) => {
             if (url.includes('/config/server/version')) {
                 return Promise.resolve({ ok: true });
             }
             return Promise.resolve({ ok: false });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;

        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(getGerritHost(service)).toBe('https://chromium-review.googlesource.com');
    });

    test('fetchClStatus prioritizes Description Change-Id', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 50));

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(")]}'\n[{\"change_id\":\"I1234567890abcdef1234567890abcdef12345678\",\"_number\":123}]")
        });
        global.fetch = fetchMock;

        const result = await service.fetchClStatus('commit-sha', 'z-change-id', 'Description\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678\n');

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('change:I1234567890abcdef1234567890abcdef12345678')
        );
        expect(result?.changeId).toBe('I1234567890abcdef1234567890abcdef12345678');
    });

    test('fetchClStatus falls back to Computed Change-Id', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 50));

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(")]}'\n[{\"change_id\":\"I000000000000ffffffffffffffffffffffffffff\",\"_number\":456}]")
        });
        global.fetch = fetchMock;

        // z (122) -> 0
        // k (107) -> f
        // "zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk" -> "000000000000ffffffffffffffffffffffffffff" (32 chars)
        const jjId = 'zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk'; 
        
        const result = await service.fetchClStatus('commit-sha', jjId, 'Description without ID');

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('change:I000000000000ffffffffffffffffffffffffffff')
        );
        expect(result?.changeNumber).toBe(456);
    });

    test('fetchClStatus ignores commit SHA if Change-Id logic fails (or just returns undefined)', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 50));

        const fetchMock = vi.fn(); // Should not be called
        global.fetch = fetchMock;

        const result = await service.fetchClStatus('commit-sha', undefined, 'Description without ID');

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
    });
    test('fetchClStatus handles invalid JJ Change-Id gracefully', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 50));

        const fetchMock = vi.fn(); // Should not be called
        global.fetch = fetchMock;

        // 'a' is not a valid char in k-z range
        // This should trigger the try-catch block in fetchClStatus
        const result = await service.fetchClStatus('commit-sha', 'invalid-id-a', 'Description without ID');

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
    });
    test('fetchClStatus caches by Change-Id', async () => {
        mockConfig.get.mockReturnValue('https://host.com');
        service = new GerritService(repo.path, jjService);
        await new Promise(resolve => setTimeout(resolve, 50));

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(")]}'\n[{\"change_id\":\"I123\",\"_number\":123}]")
        });
        global.fetch = fetchMock;

        // First call
        await service.fetchClStatus('commit-1', 'change-1', 'Desc\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Second call with DIFFERENT commit ID but SAME Change-Id - should use cache
        await service.fetchClStatus('commit-2', 'change-1', 'Desc\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
