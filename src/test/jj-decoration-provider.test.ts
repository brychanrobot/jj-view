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

        provider.updateScmAndTrackedStatus(scmStatusDecorations);

        expect(fireSpy).toHaveBeenCalledTimes(1);
    });

    it('should return SCM status decorations if present', async () => {
        provider = new JjDecorationProvider(createMock<JjService>({}), '/ws');
        const uri1 = (await import('vscode')).Uri.file('/ws/file1.txt');

        const scmStatusDecorations = new Map<string, JjStatusEntry>();
        scmStatusDecorations.set(uri1.toString(), { path: '/ws/file1.txt', status: 'modified' });

        provider.updateScmAndTrackedStatus(scmStatusDecorations);

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

        provider.updateScmAndTrackedStatus(scmStatusDecorations1);

        expect(fireSpy).toHaveBeenCalledTimes(1);

        // precise clone
        const decorations2 = new Map<string, JjStatusEntry>();
        decorations2.set('file:///a', { path: 'a', status: 'modified' });

        provider.updateScmAndTrackedStatus(decorations2);

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

        const uriTracked = (await import('vscode')).Uri.file('/ws/cached_tracked.txt');
        const uriIgnored = (await import('vscode')).Uri.file('/ws/cached_ignored.txt');

        // Exploit accessPrivate to inject cache
        const cache = accessPrivate(provider, 'trackedStatusCache') as Map<
            string,
            { isTracked: boolean; uri: vscode.Uri }
        >;
        cache.set('cached_tracked.txt', { isTracked: true, uri: uriTracked });
        cache.set('cached_ignored.txt', { isTracked: false, uri: uriIgnored });

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

    it('should fire event when clearIgnoredFileDecorationsCache is called', async () => {
        provider = new JjDecorationProvider(createMock<JjService>({}), '/ws');
        const fireSpy = vi.spyOn(accessPrivate(provider, '_onDidChangeFileDecorations'), 'fire');

        const uri = (await import('vscode')).Uri.file('/ws/dummy');
        const cache = accessPrivate(provider, 'trackedStatusCache') as Map<
            string,
            { isTracked: boolean; uri: vscode.Uri }
        >;
        cache.set('dummy', { isTracked: true, uri });

        expect(cache.size).toBe(1);

        provider.clearIgnoredFileDecorationsCache();

        expect(cache.size).toBe(0);
        expect(fireSpy).toHaveBeenCalledWith(undefined);
    });

    it('should fire event when SCM decorations are removed', () => {
        provider = new JjDecorationProvider(createMock<JjService>({}), '/ws');
        const fireSpy = vi.spyOn(accessPrivate(provider, '_onDidChangeFileDecorations'), 'fire');

        const scmStatusDecorations1 = new Map<string, JjStatusEntry>();
        scmStatusDecorations1.set('file:///a', { path: 'a', status: 'modified' });

        provider.updateScmAndTrackedStatus(scmStatusDecorations1);
        expect(fireSpy).toHaveBeenCalledTimes(1);
        vi.mocked(fireSpy).mockClear();

        const decorations2 = new Map<string, JjStatusEntry>();
        // file:///a is removed

        provider.updateScmAndTrackedStatus(decorations2);

        // Should fire because file:///a was removed
        expect(fireSpy).toHaveBeenCalledTimes(1);
        const firedUris = vi.mocked(fireSpy).mock.calls[0][0] as vscode.Uri[];
        expect(firedUris[0].toString()).toBe('file:///a');
    });

    it('should fire event when tracked status changes during background cache update', async () => {
        const mockJjService = createMock<JjService>({
            checkTrackedPaths: vi.fn().mockResolvedValue(['tracked.txt']), // Only tracked.txt is tracked
        });
        provider = new JjDecorationProvider(mockJjService, '/ws');
        const fireSpy = vi.spyOn(accessPrivate(provider, '_onDidChangeFileDecorations'), 'fire');

        const uri1 = (await import('vscode')).Uri.file('/ws/tracked.txt');
        const uri2 = (await import('vscode')).Uri.file('/ws/ignored.txt');

        // Inject initial cache state (opposite of reality)
        const cache = accessPrivate(provider, 'trackedStatusCache') as Map<
            string,
            { isTracked: boolean; uri: vscode.Uri }
        >;
        cache.set('tracked.txt', { isTracked: false, uri: uri1 }); // Currently untracked, but jj answers tracked
        cache.set('ignored.txt', { isTracked: true, uri: uri2 }); // Currently tracked, but jj answers ignored

        // Private method invocation
        const updateFn = accessPrivate(provider, 'updateTrackedStatusDecorations') as () => Promise<void>;
        await updateFn.call(provider);

        expect(mockJjService.checkTrackedPaths).toHaveBeenCalled();

        // It should have fired with both URIs because both changed
        expect(fireSpy).toHaveBeenCalledTimes(1);
        const firedUris = vi.mocked(fireSpy).mock.calls[0][0] as vscode.Uri[];
        expect(firedUris).toHaveLength(2);
        expect(firedUris.some((u) => u.fsPath.endsWith('tracked.txt'))).toBe(true);
        expect(firedUris.some((u) => u.fsPath.endsWith('ignored.txt'))).toBe(true);

        // Cache should be updated
        expect(cache.get('tracked.txt')?.isTracked).toBe(true);
        expect(cache.get('ignored.txt')?.isTracked).toBe(false);
    });

    it('should consider a directory tracked if it contains tracked files', async () => {
        const mockJjService = createMock<JjService>({
            // checkTrackedPaths returns the files inside, not the dir itself
            checkTrackedPaths: vi.fn().mockResolvedValue(['my-dir/file.txt']),
        });
        provider = new JjDecorationProvider(mockJjService, '/ws');

        const dirUri = (await import('vscode')).Uri.file('/ws/my-dir');
        const mockToken = createMock<vscode.CancellationToken>({});

        const pDir = provider.provideFileDecoration(dirUri, mockToken);

        await new Promise((r) => setTimeout(r, 60));
        const resDir = await pDir;

        // If it's considered tracked, it returns undefined instead of the 'Ignored' decoration
        expect(resDir).toBeUndefined();
    });
});
