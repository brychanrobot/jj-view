/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { accessPrivate, createMock } from './test-utils';
import { JjStatusEntry } from '../jj-types'; // Retained as it's used
import { JjService } from '../jj-service';

// Mock vscode
vi.mock('vscode', () => {
    return {
        EventEmitter: class {
            event = () => {};
            fire = () => {};
            dispose = () => {};
        },
        ThemeColor: class {
            constructor(public id: string) {}
        },
        FileDecoration: class {
            constructor(
                public badge?: string,
                public tooltip?: string,
                public color?: vscode.ThemeColor,
            ) {}
        },
        workspace: {
            asRelativePath: (uri: vscode.Uri, _includeWorkspaceFolder: boolean) => {
                return uri.fsPath.replace('/ws/', '');
            },
        },
        Uri: {
            parse: (s: string) => ({ toString: () => s }),
            file: (s: string) => ({ toString: () => `file://${s}`, fsPath: s, scheme: 'file' }),
        },
    };
});

// Import after mock
import { JjDecorationProvider } from '../jj-decoration-provider';

describe('JjDecorationProvider', () => {
    let provider: JjDecorationProvider;
    let fireSpy: unknown;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        // provider and fireSpy are now instantiated in each test to pass specific mocks
    });

    it('should fire event when decorations change', () => {
        provider = new JjDecorationProvider(createMock<JjService>({}), '/ws');
        fireSpy = vi.spyOn(accessPrivate(provider, '_onDidChangeFileDecorations'), 'fire');

        const scmStatusDecorations = new Map<string, JjStatusEntry>();
        scmStatusDecorations.set('file:///a', { path: 'a', status: 'modified' });

        provider.updateScmStatusAndClearIgnoredCache(scmStatusDecorations);

        expect(fireSpy).toHaveBeenCalledTimes(1);
    });

    it('should return SCM status decorations if present', async () => {
        provider = new JjDecorationProvider(createMock<JjService>({}), '/ws');
        const uri1 = (await import('vscode')).Uri.file('/ws/file1.txt');

        const scmStatusDecorations = new Map<string, JjStatusEntry>();
        scmStatusDecorations.set(uri1.toString(), { path: '/ws/file1.txt', status: 'modified' });

        provider.updateScmStatusAndClearIgnoredCache(scmStatusDecorations);
        
        const token = createMock<vscode.CancellationToken>();
        const result = await provider.provideFileDecoration(uri1, token);
        expect(result).toBeDefined();
        expect(result?.tooltip).toBe('Modified');
    });

    it('should NOT fire event when decorations are identical', () => {
        provider = new JjDecorationProvider(createMock<JjService>({}), '/ws');
        fireSpy = vi.spyOn(accessPrivate(provider, '_onDidChangeFileDecorations'), 'fire');

        const scmStatusDecorations1 = new Map<string, JjStatusEntry>();
        scmStatusDecorations1.set('file:///a', { path: 'a', status: 'modified' });

        provider.updateScmStatusAndClearIgnoredCache(scmStatusDecorations1);

        expect(fireSpy).toHaveBeenCalledTimes(1);

        // precise clone
        const decorations2 = new Map<string, JjStatusEntry>();
        decorations2.set('file:///a', { path: 'a', status: 'modified' });

        provider.updateScmStatusAndClearIgnoredCache(decorations2);

        // This confirms the fix
        expect(fireSpy).toHaveBeenCalledTimes(1);
    });

    it('should return ignored decoration for untracked files', async () => {
        const mockJjService = createMock<JjService>({
            checkTrackedPaths: vi.fn().mockResolvedValue(['tracked.txt']),
        });
        provider = new JjDecorationProvider(mockJjService, '/ws');

        const uriTracked = (await import('vscode')).Uri.file('/ws/tracked.txt');
        const uriIgnored = (await import('vscode')).Uri.file('/ws/ignored.txt');
        const uriOutside = (await import('vscode')).Uri.file('/outside/file.txt');
        const mockToken = createMock<vscode.CancellationToken>({});

        // Outside workspace should return immediately undefined
        expect(provider.provideFileDecoration(uriOutside, mockToken)).toBeUndefined();

        // Schedule checks
        const pTracked = provider.provideFileDecoration(uriTracked, mockToken);
        const pIgnored = provider.provideFileDecoration(uriIgnored, mockToken);

        // Wait for flush timeout
        await new Promise((r) => setTimeout(r, 60));

        const resTracked = await pTracked;
        const resIgnored = await pIgnored;

        expect(resTracked).toBeUndefined();
        expect((resIgnored as vscode.FileDecoration).color).toBeDefined();

        // Assert jjService was called with both relative paths
        expect(mockJjService.checkTrackedPaths).toHaveBeenCalledWith(['tracked.txt', 'ignored.txt']);
    });

    it('should immediately return ignored decoration for .jj folder and its contents', async () => {
        const mockJjService = createMock<JjService>({});
        provider = new JjDecorationProvider(mockJjService, '/ws');
        const jjFolder = (await import('vscode')).Uri.file('/ws/.jj');
        const jjContent = (await import('vscode')).Uri.file('/ws/.jj/config.toml');
        const mockToken = createMock<vscode.CancellationToken>({});

        const decFolder = provider.provideFileDecoration(jjFolder, mockToken) as vscode.FileDecoration;
        const decContent = provider.provideFileDecoration(jjContent, mockToken) as vscode.FileDecoration;

        expect(decFolder?.color).toBeDefined();
        expect(decContent?.color).toBeDefined();
    });

    it('should return undefined for non-file schemes or outside workspace', async () => {
        const mockJjService = createMock<JjService>({});
        provider = new JjDecorationProvider(mockJjService, '/ws');
        const gitUri = createMock<vscode.Uri>({ scheme: 'git', fsPath: '/ws/file', toString: () => '' });
        const outsideUri = createMock<vscode.Uri>({ scheme: 'file', fsPath: '/outside/file', toString: () => '' });
        const mockToken = createMock<vscode.CancellationToken>({});

        expect(provider.provideFileDecoration(gitUri, mockToken)).toBeUndefined();
        expect(provider.provideFileDecoration(outsideUri, mockToken)).toBeUndefined();
    });

    it('should return cached status synchronously without queuing', async () => {
        const mockJjService = createMock<JjService>({
            checkTrackedPaths: vi.fn(),
        });
        provider = new JjDecorationProvider(mockJjService, '/ws');

        // Exploit accessPrivate to inject cache
        const cache = accessPrivate(provider, 'trackedStatusCache') as Map<string, boolean>;
        cache.set('cached_tracked.txt', true);
        cache.set('cached_ignored.txt', false);

        const uriTracked = (await import('vscode')).Uri.file('/ws/cached_tracked.txt');
        const uriIgnored = (await import('vscode')).Uri.file('/ws/cached_ignored.txt');
        const mockToken = createMock<vscode.CancellationToken>({});

        const decTracked = provider.provideFileDecoration(uriTracked, mockToken);
        const decIgnored = provider.provideFileDecoration(uriIgnored, mockToken) as vscode.FileDecoration;

        expect(decTracked).toBeUndefined();
        expect(decIgnored?.color).toBeDefined();

        // Promise should not have been created, meaning No jj checking
        expect(mockJjService.checkTrackedPaths).not.toHaveBeenCalled();
    });

    it('should chunk requests if there are more than 100 pending checks', async () => {
        const mockJjService = createMock<JjService>({
            checkTrackedPaths: vi.fn().mockResolvedValue([]),
        });
        provider = new JjDecorationProvider(mockJjService, '/ws');
        const mockToken = createMock<vscode.CancellationToken>({});

        // Request 150 items
        for (let i = 0; i < 150; i++) {
            const uri = (await import('vscode')).Uri.file(`/ws/file${i}.txt`);
            provider.provideFileDecoration(uri, mockToken);
        }

        await new Promise((r) => setTimeout(r, 60));

        // checkTrackedPaths should be called twice (chunk size 100 and then 50)
        expect(mockJjService.checkTrackedPaths).toHaveBeenCalledTimes(2);
        expect(vi.mocked(mockJjService.checkTrackedPaths).mock.calls[0][0].length).toBe(100);
        expect(vi.mocked(mockJjService.checkTrackedPaths).mock.calls[1][0].length).toBe(50);
    });

    it('should fire onDidChangeFileDecorations when clearIgnoredFileDecorationsCache is called', () => {
        provider = new JjDecorationProvider(createMock<JjService>({}), '/ws');
        const fireSpy = vi.spyOn(accessPrivate(provider, '_onDidChangeFileDecorations'), 'fire');
        
        const cache = accessPrivate(provider, 'trackedStatusCache') as Map<string, boolean>;
        cache.set('dummy', true);

        expect(cache.size).toBe(1);

        provider.clearIgnoredFileDecorationsCache();

        expect(cache.size).toBe(0);
        expect(fireSpy).toHaveBeenCalledWith(undefined);
    });
});
