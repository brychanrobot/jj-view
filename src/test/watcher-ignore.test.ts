// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, test, expect, beforeEach, afterEach, vi, MockInstance } from 'vitest';
import * as path from 'path';
import { JjScmProvider } from '../jj-scm-provider';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';
import * as vscode from 'vscode';

// Mock VS Code
vi.mock('vscode', () => {
    return {
        workspace: {
            createFileSystemWatcher: vi.fn(),
            getConfiguration: vi.fn(),
            onDidChangeConfiguration: vi.fn().mockReturnValue({ dispose: vi.fn() }),
            registerTextDocumentContentProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
            onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
            onDidCloseTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        },
        Uri: {
            file: (f: string) => ({ fsPath: f, scheme: 'file', toString: () => `file://${f}` }),
            joinPath: (base: { fsPath: string }, ...paths: string[]) => ({
                fsPath: path.join(base.fsPath, ...paths),
                scheme: 'file',
                toString: () => `file://${path.join(base.fsPath, ...paths)}`
            }),
            from: (obj: { path: string }) => ({ ...obj, toString: () => `jj-view:${obj.path}` }),
        },
        scm: {
            createSourceControl: vi.fn().mockReturnValue({
                createResourceGroup: vi.fn().mockReturnValue({
                    resourceStates: [],
                    dispose: vi.fn(),
                }),
                inputBox: { value: '' },
                dispose: vi.fn(),
            }),
        },
        window: {
            createOutputChannel: vi.fn().mockReturnValue({
                appendLine: vi.fn(),
                dispose: vi.fn(),
            }),
        },
        Disposable: {
            from: vi.fn(),
        },
        EventEmitter: class {
            event = vi.fn();
            fire = vi.fn();
        },
        ThemeColor: class {},
        Range: class {},
        Selection: class {},
    };
});

describe('Watcher Ignore Logic', () => {
    let repo: TestRepo;
    let jj: JjService;
    let watcherCallbacks: Record<string, (uri: { fsPath: string }) => void> = {};
    let refreshStub: MockInstance;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        // Setup Watcher Mock to capture callbacks
        (vscode.workspace.createFileSystemWatcher as unknown as MockInstance).mockReturnValue({
            onDidChange: (cb: (uri: { fsPath: string }) => void) => { watcherCallbacks.change = cb; return { dispose: () => {} }; },
            onDidCreate: (cb: (uri: { fsPath: string }) => void) => { watcherCallbacks.create = cb; return { dispose: () => {} }; },
            onDidDelete: (cb: (uri: { fsPath: string }) => void) => { watcherCallbacks.delete = cb; return { dispose: () => {} }; },
            dispose: vi.fn(),
        });

        // Mock Configuration
        (vscode.workspace.getConfiguration as unknown as MockInstance).mockReturnValue({
            get: (key: string, defaultValue: unknown) => {
                if (key === 'watcherIgnore') {
                    return ['node_modules', '.git', 'ignored_folder'];
                }
                return defaultValue;
            },
        });

        const context = createMock<vscode.ExtensionContext>({ subscriptions: [] });
        const outputChannel = vscode.window.createOutputChannel('Mock');

        // Spy on prototype BEFORE instantiation to capture constructor call
        refreshStub = vi.spyOn(JjScmProvider.prototype, 'refresh').mockImplementation(async () => {});

        new JjScmProvider(context, jj, repo.path, outputChannel);
        
        // Wait for connection
        await new Promise(resolve => setTimeout(resolve, 10));
        refreshStub.mockClear();
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('Create in ignored folder does NOT trigger refresh', async () => {
        const ignoredFile = path.join(repo.path, 'ignored_folder', 'file.txt');
        const uri = { fsPath: ignoredFile };

        // Simulate Create Event
        if (watcherCallbacks.create) {
            watcherCallbacks.create(uri);
        }

        expect(refreshStub).not.toHaveBeenCalled();
    });

    test('Create in normal folder triggers refresh', async () => {
        const normalFile = path.join(repo.path, 'normal.txt');
        const uri = { fsPath: normalFile };

        // Simulate Create Event
        if (watcherCallbacks.create) {
            watcherCallbacks.create(uri);
        }

        // The scheduler might delay it, but we can verify trigger was called.
        // Actually JjScmProvider calls `_refreshScheduler.trigger()` which calls `refresh()` after delay.
        // For unit test, we might want to mock RefreshScheduler or wait.
        
        // Since we didn't mock RefreshScheduler, it uses real timers.
        // Let's force run timers? Or just verify logic in shouldIgnoreEvent if it was public.
        
        // Better: access private `_refreshScheduler` and check specific state, 
        // OR wait for the debounce.
        
        await new Promise(r => setTimeout(r, 150)); 
        expect(refreshStub).toHaveBeenCalled();
    });
    
    test('Change in ignored folder does NOT trigger refresh', async () => {
        const ignoredFile = path.join(repo.path, 'ignored_folder', 'file.txt');
        const uri = { fsPath: ignoredFile };

        if (watcherCallbacks.change) {
            watcherCallbacks.change(uri);
        }
        
        expect(refreshStub).not.toHaveBeenCalled();
    });

    test('Lock file in .jj folder does NOT trigger refresh', async () => {
        // .jj/repo/git_import_export.lock
        const lockFile = path.join(repo.path, '.jj', 'repo', 'git_import_export.lock');
        const uri = { fsPath: lockFile };

        if (watcherCallbacks.create) {
            watcherCallbacks.create(uri); 
        }

        if (watcherCallbacks.change) {
            watcherCallbacks.change(uri);
        }

        if (watcherCallbacks.delete) {
            watcherCallbacks.delete(uri);
        }

        await new Promise(r => setTimeout(r, 150));
        expect(refreshStub).not.toHaveBeenCalled();
    });

    test('Temp files in .jj folder do NOT trigger refresh', async () => {
        // .jj/working_copy/#14693893
        const tempHash = path.join(repo.path, '.jj', 'working_copy', '#14693893');
        const tempDot = path.join(repo.path, '.jj', 'working_copy', '.tmp123');

        // Test hash file
        if (watcherCallbacks.create) watcherCallbacks.create({ fsPath: tempHash });
        if (watcherCallbacks.change) watcherCallbacks.change({ fsPath: tempHash });
        if (watcherCallbacks.delete) watcherCallbacks.delete({ fsPath: tempHash });

        // Test .tmp file
        if (watcherCallbacks.create) watcherCallbacks.create({ fsPath: tempDot });
        if (watcherCallbacks.change) watcherCallbacks.change({ fsPath: tempDot });
        if (watcherCallbacks.delete) watcherCallbacks.delete({ fsPath: tempDot });

        await new Promise(r => setTimeout(r, 150));
        expect(refreshStub).not.toHaveBeenCalled();
    });
});
