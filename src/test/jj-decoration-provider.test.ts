/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// sort-imports-ignore (needed so that we can import after `vscode` is mocked)
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { NodeHostFs, NodeHostSystem } from '../core/host/node-host-system';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import type { JjStatusEntry } from '../core/jj-types';
import { Uri } from '../core/uri-utils';
import { ScopedSymlink, ScopedTempDir } from './scoped-helpers';
import { TestRepo } from './test-repo';
import { accessPrivate, createMock } from './test-utils';

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
            asRelativePath: (uri: Uri, _includeWorkspaceFolder: boolean) => {
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
import { JjDecorationModel } from '../core/jj-decoration-model';
import { VsCodeDecorationProvider } from '../vscode/providers/vscode-decoration-provider';

function createProvider(service: JjService, root = '/ws'): VsCodeDecorationProvider {
    return new VsCodeDecorationProvider(new JjDecorationModel(service, root));
}

describe('VsCodeDecorationProvider', () => {
    let provider: VsCodeDecorationProvider;
    let fireSpy: unknown;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        // provider and fireSpy are now instantiated in each test to pass specific mocks
    });

    it('should fire event when decorations change', () => {
        provider = createProvider(createMock<JjService>({}), '/ws');
        fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(provider, '_onDidChangeFileDecorations'),
            'fire',
        );

        const scmStatusDecorations = new Map<string, JjStatusEntry>();
        scmStatusDecorations.set('file:///a', { path: 'a', status: 'modified' });

        provider.updateScmAndTrackedStatus(scmStatusDecorations);

        expect(fireSpy).toHaveBeenCalledTimes(1);
    });

    it('should return SCM status decorations if present', async () => {
        provider = createProvider(createMock<JjService>({}), '/ws');
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
        provider = createProvider(createMock<JjService>({}), '/ws');
        fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(provider, '_onDidChangeFileDecorations'),
            'fire',
        );

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
        provider = createProvider(mockJjService, '/ws');

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
        provider = createProvider(mockJjService, '/ws');
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
        provider = createProvider(mockJjService, '/ws');
        const gitUri = createMock<Uri>({ scheme: 'git', fsPath: '/ws/file', toString: () => '' });
        const outsideUri = createMock<Uri>({ scheme: 'file', fsPath: '/outside/file', toString: () => '' });
        const mockToken = createMock<vscode.CancellationToken>({});

        expect(provider.provideFileDecoration(gitUri, mockToken)).toBeUndefined();
        expect(provider.provideFileDecoration(outsideUri, mockToken)).toBeUndefined();
    });

    it('should return cached status synchronously without queuing', async () => {
        const mockJjService = createMock<JjService>({
            checkTrackedPaths: vi.fn(),
        });
        provider = createProvider(mockJjService, '/ws');

        const uriTracked = (await import('vscode')).Uri.file('/ws/cached_tracked.txt');
        const uriIgnored = (await import('vscode')).Uri.file('/ws/cached_ignored.txt');

        // Exploit accessPrivate to inject cache
        const cache = accessPrivate<Map<string, { isTracked: boolean; uri: Uri }>>(
            provider.model,
            'trackedStatusCache',
        );
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
        provider = createProvider(mockJjService, '/ws');
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
        provider = createProvider(createMock<JjService>({}), '/ws');
        const fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(provider, '_onDidChangeFileDecorations'),
            'fire',
        );

        const uri = (await import('vscode')).Uri.file('/ws/dummy');
        const cache = accessPrivate<Map<string, { isTracked: boolean; uri: Uri }>>(
            provider.model,
            'trackedStatusCache',
        );
        cache.set('dummy', { isTracked: true, uri });

        expect(cache.size).toBe(1);

        provider.clearIgnoredFileDecorationsCache();

        expect(cache.size).toBe(0);
        expect(fireSpy).toHaveBeenCalledWith(undefined);
    });

    it('should fire event when SCM decorations are removed', () => {
        provider = createProvider(createMock<JjService>({}), '/ws');
        const fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(provider, '_onDidChangeFileDecorations'),
            'fire',
        );

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
        const firedUris = fireSpy.mock.calls[0][0];
        if (!Array.isArray(firedUris)) {
            throw new Error('Expected array of URIs');
        }
        expect(firedUris[0].toString()).toBe('file:///a');
    });

    it('should fire event when tracked status changes during background cache update', async () => {
        const mockJjService = createMock<JjService>({
            checkTrackedPaths: vi.fn().mockResolvedValue(['tracked.txt']), // Only tracked.txt is tracked
        });
        provider = createProvider(mockJjService, '/ws');
        const fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(provider, '_onDidChangeFileDecorations'),
            'fire',
        );

        const uri1 = (await import('vscode')).Uri.file('/ws/tracked.txt');
        const uri2 = (await import('vscode')).Uri.file('/ws/ignored.txt');

        // Inject initial cache state (opposite of reality)
        const cache = accessPrivate<Map<string, { isTracked: boolean; uri: Uri }>>(
            provider.model,
            'trackedStatusCache',
        );
        cache.set('tracked.txt', { isTracked: false, uri: uri1 }); // Currently untracked, but jj answers tracked
        cache.set('ignored.txt', { isTracked: true, uri: uri2 }); // Currently tracked, but jj answers ignored

        // Private method invocation
        const updateFn = accessPrivate<() => Promise<void>>(provider.model, 'updateTrackedStatusDecorations');
        await updateFn.call(provider.model);

        expect(mockJjService.checkTrackedPaths).toHaveBeenCalled();

        // It should have fired with both URIs because both changed
        expect(fireSpy).toHaveBeenCalledTimes(1);
        const firedUris = fireSpy.mock.calls[0][0];
        if (!Array.isArray(firedUris)) {
            throw new Error('Expected array of URIs');
        }
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
        provider = createProvider(mockJjService, '/ws');

        const dirUri = (await import('vscode')).Uri.file('/ws/my-dir');
        const mockToken = createMock<vscode.CancellationToken>({});

        const pDir = provider.provideFileDecoration(dirUri, mockToken);

        await new Promise((r) => setTimeout(r, 60));
        const resDir = await pDir;

        // If it's considered tracked, it returns undefined instead of the 'Ignored' decoration
        expect(resDir).toBeUndefined();
    });

    it('should coalesce concurrent calls for the same path and clear pendingPromises afterwards', async () => {
        const mockJjService = createMock<JjService>({
            checkTrackedPaths: vi.fn().mockResolvedValue([]),
        });
        provider = createProvider(mockJjService, '/ws');
        const uri = (await import('vscode')).Uri.file('/ws/coalesce.txt');
        const mockToken = createMock<vscode.CancellationToken>({});

        // 1. Call twice in quick succession
        const p1 = provider.provideFileDecoration(uri, mockToken);
        const p2 = provider.provideFileDecoration(uri, mockToken);

        // They should return the exact same promise (coalesced)
        expect(p1).toBe(p2);

        // 2. Wait for flush
        await new Promise((r) => setTimeout(r, 60));

        const res1 = await p1;
        const res2 = await p2;

        expect(res1?.tooltip).toBe('Ignored');
        expect(res2?.tooltip).toBe('Ignored');

        // checkTrackedPaths should only have been called once
        expect(mockJjService.checkTrackedPaths).toHaveBeenCalledTimes(1);
        expect(mockJjService.checkTrackedPaths).toHaveBeenCalledWith(['coalesce.txt']);

        // Clear mock calls and manually delete from cache to force a re-check
        vi.mocked(mockJjService.checkTrackedPaths).mockClear();
        const cache = accessPrivate<Map<string, unknown>>(provider.model, 'trackedStatusCache');
        cache.delete('coalesce.txt');

        // Verify pendingPromises map is empty for this path
        const pendingPromises = accessPrivate<Map<string, unknown>>(provider.model, 'pendingPromises');
        expect(pendingPromises.has('coalesce.txt')).toBe(false);

        // 3. A later call should issue a new query because the pending promise has been cleared
        const p3 = provider.provideFileDecoration(uri, mockToken);

        // Wait for flush
        await new Promise((r) => setTimeout(r, 60));
        await p3;

        expect(mockJjService.checkTrackedPaths).toHaveBeenCalledTimes(1);
    });

    it('should not match sibling directories sharing a workspaceRoot prefix', () => {
        const mockJjService = createMock<JjService>({});
        provider = createProvider(mockJjService, '/ws');
        const siblingUri = Uri.file('/ws-other/file.txt');
        const mockToken = createMock<vscode.CancellationToken>({});

        expect(provider.provideFileDecoration(siblingUri, mockToken)).toBeUndefined();
    });
});

describe('VsCodeDecorationProvider symlinked folders (real TestRepo)', () => {
    const symlinkDirType: fs.symlink.Type = process.platform === 'win32' ? 'junction' : 'dir';
    let repo: TestRepo | undefined;
    let activeProvider: VsCodeDecorationProvider | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new TestRepo();
        repo.init();
    });

    afterEach(async () => {
        activeProvider?.dispose();
        activeProvider = undefined;
        await repo?.dispose();
        repo = undefined;
    });

    function getRepo(): TestRepo {
        if (!repo) {
            throw new Error('TestRepo not initialized');
        }
        return repo;
    }

    function setupSymlinkRepo(): TestRepo {
        const currentRepo = getRepo();
        currentRepo.writeFile('.gitignore', '*.ignored\nignored-dir/\n');
        currentRepo.writeFile('docs/guide.md', '# Guide\n');
        currentRepo.writeFile('docs/sub/nested.md', '# Nested\n');
        currentRepo.writeFile('docs/local.ignored', 'ignored\n');
        currentRepo.writeFile('docs/ignored-dir/skip.txt', 'ignored dir file\n');
        currentRepo.writeFile('cli/index.ts', 'export const v = 1;\n');
        fs.symlinkSync('../docs', path.join(currentRepo.path, 'cli', 'docs'), symlinkDirType);
        currentRepo.snapshot();
        currentRepo.describe('base with symlinked docs');
        currentRepo.new();
        return currentRepo;
    }

    it('treats direct children, nested files/dirs, and symlink itself as tracked while keeping .gitignore entries Ignored', async () => {
        const currentRepo = setupSymlinkRepo();
        const jjService = new JjService(currentRepo.path, NO_OP_LOGGER);
        activeProvider = createProvider(jjService, currentRepo.path);
        const token = createMock<vscode.CancellationToken>({});

        const [
            symlinkSelfDec,
            guideDec,
            nestedDirDec,
            nestedFileDec,
            ignoredFileDec,
            ignoredDirDec,
            ignoredDirFileDec,
        ] = await Promise.all([
            activeProvider.provideFileDecoration(Uri.file(path.join(currentRepo.path, 'cli', 'docs')), token),
            activeProvider.provideFileDecoration(
                Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'guide.md')),
                token,
            ),
            activeProvider.provideFileDecoration(Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'sub')), token),
            activeProvider.provideFileDecoration(
                Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'sub', 'nested.md')),
                token,
            ),
            activeProvider.provideFileDecoration(
                Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'local.ignored')),
                token,
            ),
            activeProvider.provideFileDecoration(
                Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'ignored-dir')),
                token,
            ),
            activeProvider.provideFileDecoration(
                Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'ignored-dir', 'skip.txt')),
                token,
            ),
        ]);

        expect(symlinkSelfDec).toBeUndefined();
        expect(guideDec).toBeUndefined();
        expect(nestedDirDec).toBeUndefined();
        expect(nestedFileDec).toBeUndefined();
        expect(ignoredFileDec?.tooltip).toBe('Ignored');
        expect(ignoredDirDec?.tooltip).toBe('Ignored');
        expect(ignoredDirFileDec?.tooltip).toBe('Ignored');
    });

    it('uses fast path with zero realpath calls for normal tracked files and tracked symlinks', async () => {
        const currentRepo = setupSymlinkRepo();
        const realpathCalls: string[] = [];
        class TrackingFs extends NodeHostFs {
            override async realpath(targetPath: string): Promise<string> {
                realpathCalls.push(targetPath);
                return super.realpath(targetPath);
            }
        }

        const jjService = new JjService(currentRepo.path, NO_OP_LOGGER, {
            system: new NodeHostSystem({ fs: new TrackingFs() }),
        });
        activeProvider = createProvider(jjService, currentRepo.path);
        const token = createMock<vscode.CancellationToken>({});

        const [docGuideDec, docNestedDec, cliIndexDec, symEntryDec] = await Promise.all([
            activeProvider.provideFileDecoration(Uri.file(path.join(currentRepo.path, 'docs', 'guide.md')), token),
            activeProvider.provideFileDecoration(
                Uri.file(path.join(currentRepo.path, 'docs', 'sub', 'nested.md')),
                token,
            ),
            activeProvider.provideFileDecoration(Uri.file(path.join(currentRepo.path, 'cli', 'index.ts')), token),
            activeProvider.provideFileDecoration(Uri.file(path.join(currentRepo.path, 'cli', 'docs')), token),
        ]);

        expect(docGuideDec).toBeUndefined();
        expect(docNestedDec).toBeUndefined();
        expect(cliIndexDec).toBeUndefined();
        expect(symEntryDec).toBeUndefined();
        expect(realpathCalls).toHaveLength(0);

        // Lexical miss inside symlinked directory triggers realpath fallback
        const symGuideDec = await activeProvider.provideFileDecoration(
            Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'guide.md')),
            token,
        );
        expect(symGuideDec).toBeUndefined();
        expect(realpathCalls.length).toBeGreaterThan(0);
    });

    it('safely handles external symlinks, broken/dangling symlinks, and symlink loops as Ignored', async () => {
        const currentRepo = getRepo();
        using outsideDir = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-dec-outside-'));
        fs.writeFileSync(path.join(outsideDir.path, 'secret.txt'), 'outside secret\n');
        fs.writeFileSync(path.join(outsideDir.path, 'guide.md'), 'outside colliding name\n');

        currentRepo.writeFile('.gitignore', 'cli/ext-untracked\ncli/dangling\ncli/loop\n');
        currentRepo.writeFile('docs/guide.md', '# Tracked internal guide\n');
        fs.mkdirSync(path.join(currentRepo.path, 'cli'), { recursive: true });
        using _trackedExt = new ScopedSymlink(
            path.join(currentRepo.path, 'cli', 'ext-tracked'),
            outsideDir.path,
            symlinkDirType,
        );
        using _untrackedExt = new ScopedSymlink(
            path.join(currentRepo.path, 'cli', 'ext-untracked'),
            outsideDir.path,
            symlinkDirType,
        );
        using _dangling = new ScopedSymlink(
            path.join(currentRepo.path, 'cli', 'dangling'),
            path.join(currentRepo.path, 'nonexistent-target'),
            symlinkDirType,
        );
        currentRepo.snapshot();
        currentRepo.describe('external and dangling symlinks');
        currentRepo.new();

        const jjService = new JjService(currentRepo.path, NO_OP_LOGGER);
        activeProvider = createProvider(jjService, currentRepo.path);
        const token = createMock<vscode.CancellationToken>({});

        const checks: Array<Promise<vscode.FileDecoration | null | undefined>> = [
            Promise.resolve(
                activeProvider.provideFileDecoration(
                    Uri.file(path.join(currentRepo.path, 'cli', 'ext-tracked')),
                    token,
                ),
            ),
            Promise.resolve(
                activeProvider.provideFileDecoration(
                    Uri.file(path.join(currentRepo.path, 'cli', 'ext-tracked', 'secret.txt')),
                    token,
                ),
            ),
            Promise.resolve(
                activeProvider.provideFileDecoration(
                    Uri.file(path.join(currentRepo.path, 'cli', 'ext-tracked', 'guide.md')),
                    token,
                ),
            ),
            Promise.resolve(
                activeProvider.provideFileDecoration(
                    Uri.file(path.join(currentRepo.path, 'cli', 'ext-untracked')),
                    token,
                ),
            ),
            Promise.resolve(
                activeProvider.provideFileDecoration(
                    Uri.file(path.join(currentRepo.path, 'cli', 'ext-untracked', 'secret.txt')),
                    token,
                ),
            ),
            Promise.resolve(
                activeProvider.provideFileDecoration(
                    Uri.file(path.join(currentRepo.path, 'cli', 'dangling', 'missing.txt')),
                    token,
                ),
            ),
        ];

        const loopPath = path.join(currentRepo.path, 'cli', 'loop');
        let loopDisposable: ScopedSymlink | undefined;
        if (process.platform !== 'win32') {
            loopDisposable = new ScopedSymlink(loopPath, 'loop', 'dir');
            checks.push(
                Promise.resolve(
                    activeProvider.provideFileDecoration(Uri.file(path.join(loopPath, 'inner.txt')), token),
                ),
            );
        }

        try {
            const results = await Promise.all(checks);
            // Tracked external symlink entry itself is preserved as tracked
            expect(results[0]).toBeUndefined();
            // Contents of external symlink (even matching a tracked filename) must stay Ignored
            expect(results[1]?.tooltip).toBe('Ignored');
            expect(results[2]?.tooltip).toBe('Ignored');
            // Untracked external symlink and its contents stay Ignored
            expect(results[3]?.tooltip).toBe('Ignored');
            expect(results[4]?.tooltip).toBe('Ignored');
            // Dangling symlink child stays Ignored without throwing
            expect(results[5]?.tooltip).toBe('Ignored');
            if (process.platform !== 'win32') {
                // Symlink loop stays Ignored without throwing
                expect(results[6]?.tooltip).toBe('Ignored');
            }
        } finally {
            loopDisposable?.[Symbol.dispose]();
        }
    });

    it('revalidates symlinked folder entries when target files transition between tracked and ignored', async () => {
        const currentRepo = getRepo();
        currentRepo.writeFile('.gitignore', 'dynamic.txt\n');
        currentRepo.writeFile('docs/dynamic.txt', 'initially ignored\n');
        currentRepo.writeFile('docs/will-ignore.txt', 'initially tracked\n');
        fs.mkdirSync(path.join(currentRepo.path, 'cli'), { recursive: true });
        fs.symlinkSync('../docs', path.join(currentRepo.path, 'cli', 'docs'), symlinkDirType);
        currentRepo.snapshot();

        const jjService = new JjService(currentRepo.path, NO_OP_LOGGER);
        activeProvider = createProvider(jjService, currentRepo.path);
        const fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(activeProvider, '_onDidChangeFileDecorations'),
            'fire',
        );
        const token = createMock<vscode.CancellationToken>({});

        const symDynamicUri = Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'dynamic.txt'));
        const symWillIgnoreUri = Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'will-ignore.txt'));

        const [initDynamic, initWillIgnore] = await Promise.all([
            activeProvider.provideFileDecoration(symDynamicUri, token),
            activeProvider.provideFileDecoration(symWillIgnoreUri, token),
        ]);
        expect(initDynamic?.tooltip).toBe('Ignored');
        expect(initWillIgnore).toBeUndefined();

        // Transition dynamic.txt -> tracked and will-ignore.txt -> ignored
        currentRepo.writeFile('.gitignore', 'will-ignore.txt\n');
        currentRepo.untrack('docs/will-ignore.txt');
        currentRepo.snapshot();

        await activeProvider.model.updateTrackedStatusDecorations();

        expect(fireSpy).toHaveBeenCalledTimes(1);
        const firedUris = fireSpy.mock.calls[0][0];
        if (!Array.isArray(firedUris)) {
            throw new Error('Expected array of changed URIs');
        }
        expect(firedUris.some((u) => u.toString() === symDynamicUri.toString())).toBe(true);
        expect(firedUris.some((u) => u.toString() === symWillIgnoreUri.toString())).toBe(true);

        const afterDynamic = await activeProvider.provideFileDecoration(symDynamicUri, token);
        const afterWillIgnore = await activeProvider.provideFileDecoration(symWillIgnoreUri, token);
        expect(afterDynamic).toBeUndefined();
        expect(afterWillIgnore?.tooltip).toBe('Ignored');
    });

    it('drops stale overlapping updateTrackedStatusDecorations results when a newer revalidation completes first', async () => {
        const currentRepo = getRepo();
        currentRepo.writeFile('.gitignore', 'item.txt\n');
        currentRepo.writeFile('docs/item.txt', 'content\n');
        fs.mkdirSync(path.join(currentRepo.path, 'cli'), { recursive: true });
        fs.symlinkSync('../docs', path.join(currentRepo.path, 'cli', 'docs'), symlinkDirType);
        currentRepo.snapshot();

        let callCount = 0;
        let releaseFirstCall: (() => void) | undefined;
        const firstCallEntered = new Promise<void>((resolve) => {
            releaseFirstCall = resolve;
        });
        let finishFirstCall: ((value: string[]) => void) | undefined;

        class SlowFirstJjService extends JjService {
            override async checkTrackedPaths(paths: string[]): Promise<string[]> {
                const actual = await super.checkTrackedPaths(paths);
                callCount++;
                // Delay only the lexical-miss or resolved-target revalidation during the first overlapping run
                if (callCount === 3) {
                    releaseFirstCall?.();
                    return new Promise<string[]>((resolve) => {
                        finishFirstCall = resolve;
                    });
                }
                return actual;
            }
        }

        const jjService = new SlowFirstJjService(currentRepo.path, NO_OP_LOGGER);
        activeProvider = createProvider(jjService, currentRepo.path);
        const fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(activeProvider, '_onDidChangeFileDecorations'),
            'fire',
        );
        const token = createMock<vscode.CancellationToken>({});

        const symItemUri = Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'item.txt'));
        // Prime cache (calls 1 & 2) -> Ignored
        expect((await activeProvider.provideFileDecoration(symItemUri, token))?.tooltip).toBe('Ignored');
        fireSpy.mockClear();

        // Start overlapping revalidation #1 while item is still ignored
        const p1 = activeProvider.model.updateTrackedStatusDecorations();
        await firstCallEntered;

        // Track the file and run revalidation #2 to completion BEFORE #1 settles
        currentRepo.writeFile('.gitignore', '');
        currentRepo.snapshot();
        await activeProvider.model.updateTrackedStatusDecorations();
        expect(await activeProvider.provideFileDecoration(symItemUri, token)).toBeUndefined();

        // Now resolve stale revalidation #1 with old ignored result; it must be ignored!
        fireSpy.mockClear();
        finishFirstCall?.([]);
        await p1;

        expect(fireSpy).not.toHaveBeenCalled();
        expect(await activeProvider.provideFileDecoration(symItemUri, token)).toBeUndefined();
    });

    it('surfaces and updates SCM status decorations for symlinked folder paths', async () => {
        const currentRepo = setupSymlinkRepo();
        const jjService = new JjService(currentRepo.path, NO_OP_LOGGER);
        activeProvider = createProvider(jjService, currentRepo.path);
        const fireSpy = vi.spyOn(
            accessPrivate<vscode.EventEmitter<Uri | Uri[] | undefined>>(activeProvider, '_onDidChangeFileDecorations'),
            'fire',
        );
        const token = createMock<vscode.CancellationToken>({});

        const symGuideUri = Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'guide.md'));
        const symNestedUri = Uri.file(path.join(currentRepo.path, 'cli', 'docs', 'sub', 'nested.md'));

        // 1. Prime cache for symGuideUri before modification
        expect(await activeProvider.provideFileDecoration(symGuideUri, token)).toBeUndefined();
        fireSpy.mockClear();

        // 2. Mark docs/guide.md and docs/sub/nested.md as Modified in SCM status
        const modifiedEntry: JjStatusEntry = { path: 'docs/guide.md', status: 'modified' };
        const nestedEntry: JjStatusEntry = { path: 'docs/sub/nested.md', status: 'added' };
        const scmMap = new Map<string, JjStatusEntry>([
            ['/docs/guide.md', modifiedEntry],
            [Uri.file(path.join(currentRepo.path, 'docs', 'guide.md')).toString(), modifiedEntry],
            ['/docs/sub/nested.md', nestedEntry],
            [Uri.file(path.join(currentRepo.path, 'docs', 'sub', 'nested.md')).toString(), nestedEntry],
        ]);
        activeProvider.updateScmAndTrackedStatus(scmMap);

        // Cached symlinked path must receive a change notification
        expect(fireSpy).toHaveBeenCalled();
        const notifiedUris = fireSpy.mock.calls.flatMap((call) =>
            Array.isArray(call[0]) ? call[0] : call[0] ? [call[0]] : [],
        );
        expect(notifiedUris.some((u) => u.toString() === symGuideUri.toString())).toBe(true);

        // Both cached (symGuideUri) and uncached (symNestedUri) symlinked paths resolve SCM decorations
        const guideDec = await activeProvider.provideFileDecoration(symGuideUri, token);
        const nestedDec = await activeProvider.provideFileDecoration(symNestedUri, token);
        expect(guideDec?.badge).toBe('M');
        expect(guideDec?.tooltip).toBe('Modified');
        expect(nestedDec?.badge).toBe('A');
        expect(nestedDec?.tooltip).toBe('Added');

        // 3. Clearing SCM decorations notifies cached symlinked alias and clears badge
        fireSpy.mockClear();
        activeProvider.updateScmAndTrackedStatus(new Map());
        const clearedUris = fireSpy.mock.calls.flatMap((call) =>
            Array.isArray(call[0]) ? call[0] : call[0] ? [call[0]] : [],
        );
        expect(clearedUris.some((u) => u.toString() === symGuideUri.toString())).toBe(true);
        expect(await activeProvider.provideFileDecoration(symGuideUri, token)).toBeUndefined();
    });

    it('resolves symlinked workspaceRoot, trailing-slash URIs, and chained internal symlinks consistently', async () => {
        const currentRepo = setupSymlinkRepo();
        currentRepo.writeFile('shared/info.txt', 'shared info\n');
        fs.symlinkSync('../shared', path.join(currentRepo.path, 'docs', 'extra'), symlinkDirType);
        currentRepo.snapshot();

        using tempContainer = new ScopedTempDir(path.join(os.tmpdir(), 'jj-view-dec-wslink-'));
        const wsLink = path.join(tempContainer.path, 'ws-link');
        using _wsLink = new ScopedSymlink(wsLink, currentRepo.path, symlinkDirType);

        const jjService = new JjService(wsLink, NO_OP_LOGGER);
        activeProvider = createProvider(jjService, wsLink);
        const token = createMock<vscode.CancellationToken>({});

        // Chained symlink inside symlinked workspaceRoot: cli/docs/extra/info.txt -> shared/info.txt
        const chainedUri = Uri.file(path.join(wsLink, 'cli', 'docs', 'extra', 'info.txt'));
        expect(await activeProvider.provideFileDecoration(chainedUri, token)).toBeUndefined();

        // Trailing-slash directory URI inside symlinked folder normalizes without mismatch
        const trailingDirUri = Uri.file(`${path.join(wsLink, 'cli', 'docs', 'sub')}${path.sep}`);
        expect(await activeProvider.provideFileDecoration(trailingDirUri, token)).toBeUndefined();

        // Canonical workspace path also maps cleanly to tracked & SCM status
        const canonicalGuideUri = Uri.file(path.join(currentRepo.path, 'docs', 'guide.md'));
        expect(await activeProvider.provideFileDecoration(canonicalGuideUri, token)).toBeUndefined();

        activeProvider.updateScmAndTrackedStatus(
            new Map([['/docs/guide.md', { path: 'docs/guide.md', status: 'modified' }]]),
        );
        const canonicalScmDec = await activeProvider.provideFileDecoration(canonicalGuideUri, token);
        expect(canonicalScmDec?.badge).toBe('M');
    });
});
