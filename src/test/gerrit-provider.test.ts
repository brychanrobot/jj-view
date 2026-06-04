/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ChangeStatusRequest } from '../code-forge-provider';
import { GerritProvider } from '../gerrit-provider';
import type { JjService } from '../jj-service';
import { resolveGerritChangeKey, stripGerritTrailers } from '../utils/gerrit-utils';
import { accessPrivate, createMock, exposePrivate, setPrivate } from './test-utils';

// Mock VS Code
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: vi.fn(),
        })),
        onDidChangeConfiguration: vi.fn(),
    },
    Disposable: class {
        static from = vi.fn();
        dispose() {}
    },
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
        dispose = vi.fn();
    },
}));

describe('Gerrit Utils', () => {
    test('resolveGerritChangeKey strictly matches Gerrit host for Link: trailers', () => {
        const host = 'https://gerrit-review.googlesource.com';

        // Matching host with /+/ change number format
        expect(resolveGerritChangeKey('Link: https://gerrit-review.googlesource.com/+/12345\n', host)).toBe('12345');

        // Matching host with direct change number format
        expect(resolveGerritChangeKey('Link: https://gerrit-review.googlesource.com/12345\n', host)).toBe('12345');

        // Mismatched host (e.g. GitHub issue/PR links)
        expect(resolveGerritChangeKey('Link: https://github.com/owner/repo/pull/12345\n', host)).toBeUndefined();

        // Standard Change-Id still resolves
        expect(resolveGerritChangeKey('Change-Id: Iabcdef1234567890abcdef1234567890abcdef12\n', host)).toBe(
            'Iabcdef1234567890abcdef1234567890abcdef12',
        );
    });

    test('stripGerritTrailers removes Change-Id and Link trailers', () => {
        const desc =
            'My commit message\n\nChange-Id: Iabcdef1234567890abcdef1234567890abcdef12\nLink: https://gerrit-review.googlesource.com/+/12345\n';
        expect(stripGerritTrailers(desc)).toBe('My commit message');
    });
});

describe('GerritProvider', () => {
    let provider: GerritProvider;
    let mockJjService: JjService;
    let mockOutputChannel: vscode.OutputChannel;

    beforeEach(() => {
        mockJjService = createMock<JjService>({});
        mockOutputChannel = createMock<vscode.OutputChannel>({ appendLine: vi.fn() });
        provider = new GerritProvider(mockJjService, mockOutputChannel);
    });

    test('detect trims and checks for blank gerrit.host setting', async () => {
        const getMock = vi.fn().mockReturnValue('   '); // whitespace only
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
            get: getMock,
            has: vi.fn(),
            update: vi.fn(),
            inspect: vi.fn(),
        } as unknown as vscode.WorkspaceConfiguration);

        // With blank host, should fall back to checking .gitreview/remotes and return false since they don't exist
        const result = await provider.detect('/root', []);
        expect(result).toBe(false);
        expect(accessPrivate(provider, 'gerritHost')).toBeUndefined();
    });

    test('fetchStatuses preserves cache on transient fetchBatchFromNetwork error', async () => {
        setPrivate(provider, 'gerritHost', 'https://my-gerrit-host.com');

        // Populate cache
        const cache = accessPrivate<Map<string, unknown>>(provider, 'cache');
        cache.set('I12345', {
            id: 'I12345',
            number: 123,
            displayLabel: 'CL/123',
            providerName: 'Gerrit',
            status: 'NEW',
            submittable: true,
            url: 'url',
            currentRevision: 'sha-1',
        });

        // Mock fetchBatchFromNetwork to throw
        vi.spyOn(
            exposePrivate<{
                fetchBatchFromNetwork(cacheKeys: string[]): Promise<Map<string, unknown>>;
            }>(provider),
            'fetchBatchFromNetwork',
        ).mockRejectedValue(new Error('Transient network error'));

        const changes: ChangeStatusRequest[] = [
            {
                commitId: 'sha-1',
                changeId: 'I12345',
                parents: [],
            },
        ];

        const result = await provider.fetchStatuses(changes);
        expect(result).toBe(false); // No cache changes were registered

        // Verify cache was preserved (not deleted)
        expect(cache.get('I12345')).toBeDefined();
        const cachedEntry = cache.get('I12345') as { status: string } | undefined;
        expect(cachedEntry?.status).toBe('NEW');
    });
});
