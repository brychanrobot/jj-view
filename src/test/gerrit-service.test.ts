/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// Vitest
import * as vscode from 'vscode';
import { GerritService } from '../gerrit-service';
import { JjService } from '../jj-service';
import { FakeGerritServer } from './helpers/fake-gerrit-server';
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
        private listeners: ((data: unknown) => void)[] = [];
        event = (listener: (data: unknown) => void) => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    this.listeners = this.listeners.filter((l) => l !== listener);
                },
            };
        };
        fire = (data: unknown) => {
            this.listeners.forEach((l) => {
                l(data);
            });
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

        // Default: allow host probing to succeed in tests
        vi.spyOn(
            GerritService.prototype as unknown as { probeGerritHost(h: string): Promise<boolean> },
            'probeGerritHost',
        ).mockResolvedValue(true);

        jjService = new JjService(repo.path);
        fakeGerritServer = new FakeGerritServer();
        await fakeGerritServer.start();
    });

    afterEach(async () => {
        if (service) {
            service.dispose();
        }
        if (fakeGerritServer) {
            await fakeGerritServer.stop();
        }
        repo.dispose();
        vi.clearAllMocks();
    });

    // Helper to access private property without using 'any'
    function getGerritHost(srv: GerritService): string | undefined {
        return (srv as unknown as { _gerritHost: string | undefined })._gerritHost;
    }

    test('Detects from extension setting (highest priority)', async () => {
        mockConfig.get.mockImplementation((key: string) => {
            if (key === 'gerrit.host') {
                return 'https://setting-host.com';
            }
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

    test('ensureFreshStatuses prioritizes Description Change-Id', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 123,
            status: 'NEW',
        });

        const desc = 'Description\n\nChange-Id: I1234567890abcdef1234567890abcdef12345678\n';
        await service.ensureFreshStatuses([
            { commitId: 'commit-sha', changeId: 'z-change-id', description: desc, parents: [] },
        ]);
        const result = service.getCachedClStatus('z-change-id', desc);

        expect(result?.changeId).toBe('I1234567890abcdef1234567890abcdef12345678');
    });

    test('ensureFreshStatuses prioritizes Link trailer when Change-Id is missing', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        fakeGerritServer.addChange({
            change_id: 'Iabcd',
            _number: 7812281,
            status: 'NEW',
        });

        const desc = 'Description\n\nLink: https://chromium-review.googlesource.com/c/chromium/src/+/7812281\n';
        await service.ensureFreshStatuses([{ commitId: 'commit-sha', description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        expect(result?.changeNumber).toBe(7812281);
    });

    test('ensureFreshStatuses extracts change number from different Link formats', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        fakeGerritServer.addChange({ _number: 111, status: 'NEW', change_id: 'I111' });
        fakeGerritServer.addChange({ _number: 222, status: 'NEW', change_id: 'I222' });
        fakeGerritServer.addChange({ _number: 333, status: 'NEW', change_id: 'I333' });
        fakeGerritServer.addChange({ _number: 444, status: 'NEW', change_id: 'I444' });

        // Format 1: /+/123
        const desc1 = 'Desc\n\nLink: https://host.com/c/proj/+/111';
        await service.ensureFreshStatuses([{ commitId: 'c1', description: desc1, parents: [] }]);
        expect(service.getCachedClStatus(undefined, desc1)?.changeNumber).toBe(111);

        // Format 2: /123
        const desc2 = 'Desc\n\nLink: https://host.com/222';
        await service.ensureFreshStatuses([{ commitId: 'c2', description: desc2, parents: [] }]);
        expect(service.getCachedClStatus(undefined, desc2)?.changeNumber).toBe(222);

        // Format 3: /123/ (trailing slash)
        const desc3 = 'Desc\n\nLink: https://host.com/333/';
        await service.ensureFreshStatuses([{ commitId: 'c3', description: desc3, parents: [] }]);
        expect(service.getCachedClStatus(undefined, desc3)?.changeNumber).toBe(333);

        // Format 4: /+/123/4 (with patchset number — should extract 444, not 7)
        const desc4 = 'Desc\n\nLink: https://host.com/c/proj/+/444/7';
        await service.ensureFreshStatuses([{ commitId: 'c4', description: desc4, parents: [] }]);
        expect(service.getCachedClStatus(undefined, desc4)?.changeNumber).toBe(444);
    });

    test('ensureFreshStatuses prioritizes Change-Id over Link trailer', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 123,
            status: 'NEW',
        });

        const desc = 'Description with Link trailer\n\nLink: https://host.com/c/proj/+/123\n';
        const jjId = 'I1234567890abcdef1234567890abcdef12345678';

        await service.ensureFreshStatuses([{ commitId: 'commit-sha', changeId: jjId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(jjId, desc);

        expect(result?.changeId).toBe(changeId);
        expect(result?.changeNumber).toBe(123);
    });

    test('ensureFreshStatuses falls back to Computed Change-Id', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I000000000000ffffffffffffffffffffffffffff';
        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 456,
            status: 'NEW',
        });

        // z (122) -> 0
        // k (107) -> f
        // "zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk" -> "000000000000ffffffffffffffffffffffffffff" (32 chars)
        const jjId = 'zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
        const desc = 'Description without ID';

        await service.ensureFreshStatuses([{ commitId: 'commit-sha', changeId: jjId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(jjId, desc);

        expect(result?.changeNumber).toBe(456);
    });

    test('ensureFreshStatuses ignores commit SHA if Change-Id logic fails (or just returns undefined)', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const desc = 'Description without ID';
        await service.ensureFreshStatuses([{ commitId: 'commit-sha', description: desc, parents: [] }]);
        const result = service.getCachedClStatus(undefined, desc);

        expect(result).toBeUndefined();
    });

    test('ensureFreshStatuses handles invalid JJ Change-Id gracefully', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const desc = 'Description with old Change-Id footer\n\nChange-Id: Ioldid\n';
        await service.ensureFreshStatuses([
            {
                commitId: 'commit-sha',
                changeId: 'invalid-jj-id-with-a',
                description: desc,
                parents: [],
            },
        ]);
        const result = service.getCachedClStatus('invalid-jj-id-with-a', desc);

        expect(result).toBeUndefined();
    });

    test('ensureFreshStatuses updates cache when status changes', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // Pre-populate gerrit server
        const cacheKey = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey,
            status: 'NEW',
            _number: 123,
        });

        const desc = `Change-Id: ${cacheKey}`;
        const item = { commitId: 'c1', changeId: 'change-1', description: desc, parents: [] };

        // Cache it first
        await service.ensureFreshStatuses([item]);

        // Now update it on server
        fakeGerritServer.updateChange(cacheKey, { status: 'MERGED' });

        await service.ensureFreshStatuses([item]);
        const result = service.getCachedClStatus('change-1', desc);

        expect(result?.status).toBe('MERGED');
    });

    test('ensureFreshStatuses detects changes', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // 1. Setup Cache with OLD data
        // 1. Setup Gerrit with OLD data and cache it
        const cacheKey1 = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey1,
            status: 'NEW',
            _number: 123,
        });
        const desc1 = `Change-Id: ${cacheKey1}`;
        await service.ensureFreshStatuses([
            { commitId: 'commit-1', changeId: 'change-1', description: desc1, parents: [] },
        ]);

        // 2. Update Gerrit with NEW data (MERGED)
        fakeGerritServer.updateChange(cacheKey1, { status: 'MERGED', submittable: false });

        const items = [
            {
                commitId: 'commit-1',
                parents: [],
                changeId: 'change-1',
                description: `Change-Id: ${cacheKey1}`,
            },
        ];

        const hasChanges = await service.ensureFreshStatuses(items);

        expect(hasChanges).toBe(true);
        expect(service.getCachedClStatus(undefined, `Change-Id: ${cacheKey1}`)?.status).toBe('MERGED');
    });

    test('ensureFreshStatuses returns false if no changes', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // 1. Setup Gerrit and Cache
        const cacheKey3 = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey3,
            status: 'NEW',
            _number: 123,
        });
        const desc3 = `Change-Id: ${cacheKey3}`;
        await service.ensureFreshStatuses([
            { commitId: 'commit-1', changeId: 'change-1', description: desc3, parents: [] },
        ]);

        // 2. No updates to Gerrit (still NEW)

        const items3 = [
            {
                commitId: 'c3',
                parents: [],
                changeId: cacheKey3,
                description: `Change-Id: ${cacheKey3}`,
            },
        ];

        const hasChanges3 = await service.ensureFreshStatuses(items3);

        expect(hasChanges3).toBe(false);
    });

    test('startPolling clears cache and fires onDidUpdate', async () => {
        vi.useFakeTimers();

        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();
        expect(service.isEnabled).toBe(true);

        // Pre-populate gerrit
        const cacheKey = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey,
            status: 'NEW',
            _number: 123,
        });
        const desc = `Change-Id: ${cacheKey}`;
        await service.ensureFreshStatuses([{ commitId: 'c1', changeId: 'change-1', description: desc, parents: [] }]);

        // Verify it's cached
        expect(service.getCachedClStatus(undefined, `Change-Id: ${cacheKey}`)).toBeDefined();

        // Track onDidUpdate calls
        let updateFired = false;
        const disposable = service.onDidUpdate(() => {
            updateFired = true;
        });

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
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();
        expect(service.isEnabled).toBe(true);

        // Pre-populate gerrit
        const cacheKey = 'I1234567890abcdef1234567890abcdef12345678';
        fakeGerritServer.addChange({
            change_id: cacheKey,
            status: 'NEW',
            _number: 123,
        });
        const desc = `Change-Id: ${cacheKey}`;
        await service.ensureFreshStatuses([{ commitId: 'c1', changeId: 'change-1', description: desc, parents: [] }]);

        // Verify it's cached
        expect(service.getCachedClStatus(undefined, `Change-Id: ${cacheKey}`)).toBeDefined();

        // Track onDidUpdate calls
        let updateFired = false;
        const disposable = service.onDidUpdate(() => {
            updateFired = true;
        });

        service.forceRefresh();

        expect(updateFired).toBe(true);
        disposable.dispose();
    });

    test('ensureFreshStatuses parses changed files', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
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
                        '/COMMIT_MSG': { status: 'A' },
                    },
                },
            },
        });

        const desc = `Change-Id: ${changeId}`;
        await service.ensureFreshStatuses([{ commitId: 'local-sha', changeId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(changeId, desc);

        expect(result?.files).toEqual({
            'file1.txt': { status: 'M', newSha: 'abc' },
            'file2.txt': { status: 'A', newSha: 'def' },
            'deleted.txt': { status: 'D', newSha: undefined },
        });
    });

    test('ensureFreshStatuses detects extra local files as not synced', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
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
                        'file1.txt': { status: 'A', new_sha: 'abc' },
                    },
                },
            },
        });

        // 3. Trigger fetch
        const desc = `Change-Id: ${changeId}`;
        await service.ensureFreshStatuses([{ commitId, changeId, description: desc, parents: [] }]);
        const result = service.getCachedClStatus(changeId, desc);

        // 4. Verify
        expect(result).toBeDefined();
        // Should be not synced because file2.txt is extra locally
        expect(result?.contentSynced).toBeFalsy();
    });

    test('ensureFreshStatuses detects description mismatch as not synced', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I1234567890abcdef1234567890abcdef12345678';
        const currentRev = 'commit-sha-on-gerrit';

        // Match files exactly but change description
        repo.writeFile('file1.txt', 'content1');
        const localDesc = `Local Description\n\nChange-Id: ${changeId}`;
        await jjService.describe(localDesc);
        const localHashes = await jjService.getGitBlobHashes(repo.getCommitId('@'), ['file1.txt']);

        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 123,
            status: 'NEW',
            current_revision: currentRev,
            revisions: {
                [currentRev]: {
                    commit: { message: `Remote Description\n\nChange-Id: ${changeId}` },
                    files: {
                        'file1.txt': { status: 'A', new_sha: localHashes.get('file1.txt') },
                    },
                },
            },
        });

        const commitId = repo.getCommitId('@').trim();

        // Pass a DIFFERENT local description
        await service.ensureFreshStatuses([{ commitId, changeId, description: localDesc, parents: [] }]);
        const resultNoSync = service.getCachedClStatus(changeId, localDesc);
        expect(resultNoSync?.contentSynced).toBeFalsy();
    });

    test('ensureFreshStatuses accepts matching description regardless of whitespace', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeId = 'I1234567890abcdef1234567890abcdef12345678';
        const currentRev = 'commit-sha-on-gerrit';

        const baseDescription = `Same Description\n\nChange-Id: ${changeId}`;

        repo.writeFile('file1.txt', 'content1');
        await jjService.describe(baseDescription);
        const localHashes = await jjService.getGitBlobHashes(repo.getCommitId('@'), ['file1.txt']);

        fakeGerritServer.addChange({
            change_id: changeId,
            _number: 123,
            status: 'NEW',
            current_revision: currentRev,
            revisions: {
                [currentRev]: {
                    commit: { message: `${baseDescription}\n\n` }, // Extra newlines remotely
                    files: {
                        'file1.txt': { status: 'A', new_sha: localHashes.get('file1.txt') },
                    },
                },
            },
        });

        const commitId = repo.getCommitId('@').trim();

        // Pass exactly the base description (different whitespace/trimming)
        await service.ensureFreshStatuses([{ commitId, changeId, description: baseDescription, parents: [] }]);
        const resultSynced = service.getCachedClStatus(changeId, baseDescription);
        expect(resultSynced?.contentSynced).toBeTruthy();
    });

    test('ensureFreshStatuses ignores Change-Id footer differences', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const jjId = 'zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
        const gerritId = 'I000000000000ffffffffffffffffffffffffffff';
        const currentRev = 'commit-sha-on-gerrit';

        repo.writeFile('file1.txt', 'content1');
        const localDesc = 'Local description has no Change-Id';
        await jjService.describe(localDesc);
        const localHashes = await jjService.getGitBlobHashes(repo.getCommitId('@'), ['file1.txt']);

        fakeGerritServer.addChange({
            change_id: gerritId,
            _number: 123,
            status: 'NEW',
            current_revision: currentRev,
            revisions: {
                [currentRev]: {
                    commit: { message: `Local description has no Change-Id\n\nChange-Id: ${gerritId}` }, // Gerrit has it
                    files: {
                        'file1.txt': { status: 'A', new_sha: localHashes.get('file1.txt') },
                    },
                },
            },
        });

        const commitId = repo.getCommitId('@').trim();

        await service.ensureFreshStatuses([{ commitId, changeId: jjId, description: localDesc, parents: [] }]);
        const resultSynced = service.getCachedClStatus(jjId, localDesc);
        expect(resultSynced?.contentSynced).toBeTruthy();
    });

    test('ensureFreshStatuses ignores Link trailer footer differences during sync', async () => {
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        const changeNumber = 7812281;
        const currentRev = 'commit-sha-on-gerrit';

        repo.writeFile('file1.txt', 'content1');
        const localDesc = 'Local description has no Link trailer';
        await jjService.describe(localDesc);
        const localHashes = await jjService.getGitBlobHashes(repo.getCommitId('@'), ['file1.txt']);

        fakeGerritServer.addChange({
            change_id: 'I000000000000ffffffffffffffffffffffffffff',
            _number: changeNumber,
            status: 'NEW',
            current_revision: currentRev,
            revisions: {
                [currentRev]: {
                    commit: {
                        message: `Local description has no Link trailer\n\nLink: https://host.com/${changeNumber}`,
                    },
                    files: {
                        'file1.txt': { status: 'A', new_sha: localHashes.get('file1.txt') },
                    },
                },
            },
        });

        const commitId = repo.getCommitId('@').trim();
        const jjId = 'zzzzzzzzzzzzkkkkkkkkkkkkkkkkkkkkkkkkkkkk';

        await service.ensureFreshStatuses([{ commitId, changeId: jjId, description: localDesc, parents: [] }]);
        const resultSynced = service.getCachedClStatus(jjId, localDesc);
        expect(resultSynced?.contentSynced).toBeTruthy();
    });

    test('requestRefreshWithBackoffs schedules multiple refreshes', async () => {
        vi.useFakeTimers();
        mockConfig.get.mockReturnValue(fakeGerritServer.url);
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
        mockConfig.get.mockReturnValue(fakeGerritServer.url);

        // Initialize service
        service = new GerritService(repo.path, jjService);
        await service.awaitReady();

        // Spy on _onDidUpdate.fire to verify refreshes
        let updateCount = 0;
        const disposable = service.onDidUpdate(() => {
            updateCount++;
        });

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
