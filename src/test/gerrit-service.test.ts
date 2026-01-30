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
    });

    afterEach(async () => {
        if (service) {
            service.dispose();
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
});
