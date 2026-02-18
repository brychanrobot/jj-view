/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { describe, it, beforeEach, afterEach, vi, expect, Mock, MockInstance } from 'vitest';
import { ChangeDetectionManager } from '../change-detection-manager';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';
import { DirectoryWatcher } from '../directory-watcher';

// Mock VS Code
const mockGetConfiguration = vi.fn();
const mockOnDidSaveTextDocument = vi.fn();
const mockOnDidChangeWindowState = vi.fn();
const mockOnDidChangeConfiguration = vi.fn();
const mockCreateFileSystemWatcher = vi.fn();

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock({
        workspace: {
            getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args),
            onDidSaveTextDocument: (...args: unknown[]) => mockOnDidSaveTextDocument(...args),
            onDidChangeConfiguration: (...args: unknown[]) => mockOnDidChangeConfiguration(...args),
            createFileSystemWatcher: (...args: unknown[]) => mockCreateFileSystemWatcher(...args),
        },
        window: {
            onDidChangeWindowState: (...args: unknown[]) => mockOnDidChangeWindowState(...args),
            state: { focused: true },
        },
    });
});

describe('ChangeDetectionManager', () => {
    let repo: TestRepo;
    let jj: JjService;
    let changeManager: ChangeDetectionManager | undefined;
    let outputChannel: vscode.OutputChannel;
    let triggerRefreshSpy: Mock<(event: { forceSnapshot: boolean; reason: string }) => Promise<void>>;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        
        jj = new JjService(repo.path);
        
        outputChannel = createMock<vscode.OutputChannel>({
            appendLine: vi.fn(),
        });

        triggerRefreshSpy = vi.fn().mockImplementation(() => Promise.resolve());

        // Reset mocks
        mockGetConfiguration.mockReset();
        mockOnDidSaveTextDocument.mockReturnValue({ dispose: vi.fn() });
        mockOnDidChangeWindowState.mockReturnValue({ dispose: vi.fn() });
        mockOnDidChangeConfiguration.mockReturnValue({ dispose: vi.fn() });
        
        // Default config: polling
        mockGetConfiguration.mockReturnValue({
            get: (key: string, defaultValue: unknown) => {
                if (key === 'fileWatcherMode') return 'polling';
                return defaultValue;
            }
        });
    });

    afterEach(async () => {
        // Dispose manager first to stop watchers
        if (changeManager) {
            await changeManager.dispose();
            changeManager = undefined;
        }
        
        repo.dispose();
        vi.clearAllMocks();
    });

    const waitForLog = async (pattern: string) => {
        await vi.waitFor(() => {
            const calls = (outputChannel.appendLine as Mock).mock.calls;
            const found = calls.some(call => call[0].includes(pattern));
            if (!found) {
                throw new Error(`Log pattern "${pattern}" not found`);
            }
        }, { timeout: 10000, interval: 50 });
    };

    describe('Polling Logic (Fake Timers)', () => {
        let watcherStartSpy: MockInstance;

        beforeEach(() => {
            vi.useFakeTimers();
            // Suppress native watcher start for polling tests
            // We want to test logic, not integration here
            watcherStartSpy = vi.spyOn(DirectoryWatcher.prototype, 'start').mockResolvedValue();
        });

        afterEach(() => {
            watcherStartSpy.mockRestore();
            vi.clearAllTimers();
            vi.useRealTimers();
        });

        it('starts in polling mode by default and respects 5s gap after resolution', async () => {
            let resolveRefresh: (value: void | PromiseLike<void>) => void;
            const refreshPromise = new Promise<void>((resolve) => {
                resolveRefresh = resolve;
            });
            
            triggerRefreshSpy.mockReturnValue(refreshPromise);
            
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy);

            // Verify configuration was read
            expect(mockGetConfiguration).toHaveBeenCalledWith('jj-view');

            // 1. Initial 5s wait
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 2. Wait another 5s while refresh is still pending
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1); // Should NOT have called again

            // 3. Resolve the refresh
            resolveRefresh!();
            await vi.runAllTicks(); // Process promise resolution
            
            // Should NOT call immediately upon resolution
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 4. Wait 5s AFTER resolution
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(2); // Now it should have called again
        });

        it('pauses polling on blur and resumes on focus', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy);

            // Get the window state change callback
            expect(mockOnDidChangeWindowState).toHaveBeenCalled();
            const onDidChangeWindowState = mockOnDidChangeWindowState.mock.calls[0][0];

            // 1. Initially focused, wait for first poll (5s interval)
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 2. Blur the window
            const windowMock = vscode.window as unknown as { state: { focused: boolean } };
            windowMock.state.focused = false;
            onDidChangeWindowState({ focused: false });

            // Wait 5.1s, should NOT call refresh (paused)
            await vi.advanceTimersByTimeAsync(5100);
            
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 3. Focus the window
            windowMock.state.focused = true;
            onDidChangeWindowState({ focused: true });

            // Wait for the immediate (10ms) poll to trigger
            await vi.advanceTimersByTimeAsync(100);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(2);

            // Wait another 5.1s to verify polling continues
            await vi.advanceTimersByTimeAsync(5100);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(3);
        });

        it('triggers refresh on file save (VS Code event)', async () => {
             // Fake timers for this one too since it's generic logic
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy);
    
            // Verify we subscribed to onDidSaveTextDocument
            expect(mockOnDidSaveTextDocument).toHaveBeenCalled();
            const onDidSaveTextDocument = mockOnDidSaveTextDocument.mock.calls[mockOnDidSaveTextDocument.mock.calls.length - 1][0];
            
            // Simulate save
            const mockDoc = createMock<vscode.TextDocument>({
                uri: vscode.Uri.file(path.join(repo.path, 'test.txt'))
            });
            
            onDidSaveTextDocument(mockDoc);
    
            expect(triggerRefreshSpy).toHaveBeenCalledWith({
                forceSnapshot: true,
                reason: 'file saved'
            });
        });
    });

    describe('Native Watcher Integration (Real Timers)', () => {
        beforeEach(() => {
            vi.useRealTimers();
        });

        it('switches to watch mode when configured and detects changes', async () => {
            // Setup config to return 'watch'
            mockGetConfiguration.mockReturnValue({
                get: (key: string, defaultValue: unknown) => {
                    if (key === 'fileWatcherMode') return 'watch';
                    return defaultValue;
                }
            });
    
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy);
    
            // Wait for watchers to start
            await waitForLog('Working Copy Watcher] Started');
    
            // Create a file to trigger the watcher
            const testFile = path.join(repo.path, 'test_watch.txt');
            await fs.writeFile(testFile, 'hello');
            
            // Wait for event to propagate
            await vi.waitFor(() => {
                const found = triggerRefreshSpy.mock.calls.some(call => call[0].reason === 'file watcher event');
                expect(found, 'Trigger refresh for file watcher event was not called').toBe(true);
            }, { timeout: 10000, interval: 100 });
        });

        it('handles op_heads changes with real watcher', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy);
            
            // Wait for op_heads watcher to start
            await waitForLog('OpHeads Watcher] Started');
    
            // Trigger an op_heads change
            const opHeadsPath = path.join(repo.path, '.jj', 'repo', 'op_heads', 'new_head');
            await fs.writeFile(opHeadsPath, 'commitid');
    
            // Wait for event
            await vi.waitFor(() => {
                const found = triggerRefreshSpy.mock.calls.some(call => call[0].reason === 'jj operation');
                expect(found, 'Trigger refresh for jj operation was not called').toBe(true);
            }, { timeout: 10000, interval: 100 });
        });

        it('filters out negated patterns from .gitignore', async () => {
             // Setup config to return 'watch'
             mockGetConfiguration.mockReturnValue({
                 get: (key: string, defaultValue: unknown) => {
                     if (key === 'fileWatcherMode') return 'watch';
                     return defaultValue;
                 }
             });
     
             // Create .gitignore with negated pattern and a directory to ignore
             await fs.writeFile(path.join(repo.path, '.gitignore'), 'ignore_me\n!keep_me\n#comment');
             await fs.mkdir(path.join(repo.path, 'ignore_me'), { recursive: true });
     
             changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy);
     
             // Wait for watcher to start, then settle to flush any
             // FSEvents catch-up events from the mkdir before the watcher started.
             await waitForLog('Working Copy Watcher] Started');
             await new Promise(resolve => setTimeout(resolve, 500));
             triggerRefreshSpy.mockClear();

             // Write to the ignored directory — should NOT trigger
             await fs.writeFile(path.join(repo.path, 'ignore_me', 'secret.txt'), 'hidden');

             // Wait to confirm no event fires for ignored file
             await new Promise(resolve => setTimeout(resolve, 500));
             const ignoredCalls = triggerRefreshSpy.mock.calls.filter(call => call[0].reason === 'file watcher event');
             expect(ignoredCalls, 'Ignored file should not have triggered a refresh').toHaveLength(0);

             // Write to a non-ignored path — SHOULD trigger
             await fs.writeFile(path.join(repo.path, 'visible.txt'), 'visible');

             await vi.waitFor(() => {
                 const found = triggerRefreshSpy.mock.calls.some(call => call[0].reason === 'file watcher event');
                 expect(found, 'Expected file watcher event for visible.txt').toBe(true);
             }, { timeout: 10000, interval: 100 });
         });
    });
});
