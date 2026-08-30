/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from 'vitest';
import { ChangeDetectionManager } from '../core/change-detection-manager';
import { DirectoryWatcher } from '../core/directory-watcher';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { Uri } from '../core/uri-utils';
import type { LoggerChannel } from '../utils/output-channel';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { accessPrivate, createMockLogOutputChannel } from './test-utils';

describe('ChangeDetectionManager', () => {
    let repo: TestRepo;
    let jj: JjService;
    let host: FakeHostEnvironment;
    let changeManager: ChangeDetectionManager | undefined;
    let outputChannel: LoggerChannel;
    let triggerRefreshSpy: Mock<(event: { forceSnapshot: boolean; reason: string }) => Promise<void>>;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        jj = new JjService(repo.path, NO_OP_LOGGER);
        host = new FakeHostEnvironment();

        outputChannel = createMockLogOutputChannel({
            appendLine: vi.fn(),
        });

        triggerRefreshSpy = vi.fn().mockImplementation(() => Promise.resolve());

        // Default config: polling
        host.config.set('fileWatcherMode', 'polling');
    });

    afterEach(async () => {
        // Dispose manager first to stop watchers
        if (changeManager) {
            await changeManager.dispose();
            changeManager = undefined;
        }

        vi.clearAllMocks();
    });

    const waitForLog = async (pattern: string) => {
        await vi.waitFor(
            () => {
                const infoCalls = (outputChannel.info as Mock).mock.calls;
                const debugCalls = (outputChannel.debug as Mock).mock.calls;
                const errorCalls = (outputChannel.error as Mock).mock.calls;
                const calls = [...infoCalls, ...debugCalls, ...errorCalls];
                const found = calls.some((call) => call[0].includes(pattern));
                if (!found) {
                    throw new Error(`Log pattern "${pattern}" not found`);
                }
            },
            { timeout: 10000, interval: 50 },
        );
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
            let resolveRefresh!: (value: void | PromiseLike<void>) => void;
            const refreshPromise = new Promise<void>((resolve) => {
                resolveRefresh = resolve;
            });

            triggerRefreshSpy.mockReturnValue(refreshPromise);

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // 1. Initial 5s wait
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 2. Wait another 5s while refresh is still pending
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1); // Should NOT have called again

            // 3. Resolve the refresh
            resolveRefresh();
            await vi.runAllTicks(); // Process promise resolution

            // Should NOT call immediately upon resolution
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 4. Wait 5s AFTER resolution
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(2); // Now it should have called again
        });

        it('pauses polling on blur and resumes on focus', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // 1. Initially focused, wait for first poll (5s interval)
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 2. Blur the host window
            host.ui.setFocused(false);

            // Wait 5.1s, should NOT call refresh (paused)
            await vi.advanceTimersByTimeAsync(5100);

            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 3. Focus the host window
            host.ui.setFocused(true);

            // Wait for the immediate (10ms) poll to trigger
            await vi.advanceTimersByTimeAsync(100);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(2);

            // Wait another 5.1s to verify polling continues
            await vi.advanceTimersByTimeAsync(5100);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(3);
        });

        it('triggers refresh on file save (Host document save event)', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Simulate host save event
            host.documents.fireDidSaveDocument(Uri.file(path.join(repo.path, 'test.txt')));

            expect(triggerRefreshSpy).toHaveBeenCalledWith({
                forceSnapshot: true,
                reason: 'file saved',
            });
        });

        it('ignores file save events for non-file schemes, .jj internal files, and files outside workspace', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // 1. Non-file scheme
            host.documents.fireDidSaveDocument(Uri.parse('untitled:Untitled-1'));
            expect(triggerRefreshSpy).not.toHaveBeenCalled();

            // 2. Internal .jj file
            host.documents.fireDidSaveDocument(Uri.file(path.join(repo.path, '.jj', 'repo', 'op_heads', 'head1')));
            expect(triggerRefreshSpy).not.toHaveBeenCalled();

            // 3. File outside workspace
            host.documents.fireDidSaveDocument(Uri.file(path.join(repo.path, '..', 'outside.txt')));
            expect(triggerRefreshSpy).not.toHaveBeenCalled();
        });
    });

    describe('Native Watcher Integration (Real Timers)', () => {
        beforeEach(() => {
            vi.useRealTimers();
        });

        it('switches to watch mode when configured and detects changes', async () => {
            // Setup config to return 'watch'
            host.config.set('fileWatcherMode', 'watch');

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for watchers to start
            await waitForLog('Working Copy Watcher] Started');
            // Give it a bit more time to settle
            await new Promise((resolve) => setTimeout(resolve, 800));

            // Create a file to trigger the watcher
            const testFile = path.join(repo.path, 'test_watch.txt');
            await fs.writeFile(testFile, 'hello');

            // Wait for event to propagate
            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Trigger refresh for file watcher event was not called').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('switches mode dynamically when onDidChangeConfiguration fires at runtime', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Initially polling mode
            await changeManager.awaitWatchersReady();

            // Change setting at runtime
            host.config.set('fileWatcherMode', 'watch');

            // Wait for watcher to start dynamically
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 800));

            const testFile = path.join(repo.path, 'dynamic_watch.txt');
            await fs.writeFile(testFile, 'dynamic');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Trigger refresh for dynamic file watcher event was not called').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('falls back to polling mode if working copy watcher fails to start', async () => {
            const watcherStartSpy = vi.spyOn(DirectoryWatcher.prototype, 'start').mockImplementation(async function (
                this: DirectoryWatcher,
            ) {
                const name = accessPrivate<string>(this, 'name');
                if (name === 'Working Copy Watcher') {
                    throw new Error('Watch backend startup failure simulation');
                }
            });

            try {
                host.config.set('fileWatcherMode', 'watch');
                changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

                await waitForLog('Falling back to polling mode');
                expect(outputChannel.info).toHaveBeenCalledWith(
                    expect.stringContaining('Falling back to polling mode'),
                );
            } finally {
                watcherStartSpy.mockRestore();
            }
        });

        it('handles op_heads changes with real watcher', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for op_heads watcher to start
            await waitForLog('OpHeads Watcher] Started');

            // Trigger an op_heads change using a separate TestRepo instance
            // (Simulates an external jj operation)
            const triggeringRepo = new TestRepo(repo.path);
            triggeringRepo.new([], 'trigger refresh');

            // Wait for event
            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'jj operation');
                    expect(found, 'Trigger refresh for jj operation was not called').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('handles op_heads changes in non-default workspace', async () => {
            const secondRepo = repo.workspaceAdd('second_workspace');
            const secondJj = new JjService(secondRepo.path, {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {},
            });

            changeManager = new ChangeDetectionManager(
                secondRepo.path,
                secondJj,
                outputChannel,
                triggerRefreshSpy,
                host,
            );

            // Wait for op_heads watcher to start
            await waitForLog('OpHeads Watcher] Started');

            // Trigger an op_heads change in the second workspace using the secondary TestRepo instance
            // (Acts as an external operation from the perspective of the ChangeDetectionManager's JjService)
            secondRepo.new([], 'trigger refresh');

            // Wait for event
            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'jj operation');
                    expect(found, 'Trigger refresh for jj operation was not called in second workspace').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('filters out negated patterns from .gitignore', async () => {
            // Setup config to return 'watch'
            host.config.set('fileWatcherMode', 'watch');

            // Create .gitignore with negated pattern and a directory to ignore
            await fs.writeFile(path.join(repo.path, '.gitignore'), 'ignore_me\n!keep_me\n#comment');
            await fs.mkdir(path.join(repo.path, 'ignore_me'), { recursive: true });

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for watcher to start, then settle to flush any
            // FSEvents catch-up events from the mkdir before the watcher started.
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 500));
            triggerRefreshSpy.mockClear();

            // Write to the ignored directory — should NOT trigger
            await fs.writeFile(path.join(repo.path, 'ignore_me', 'secret.txt'), 'hidden');

            // Wait to confirm no event fires for ignored file
            await new Promise((resolve) => setTimeout(resolve, 500));
            const ignoredCalls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(ignoredCalls, 'Ignored file should not have triggered a refresh').toHaveLength(0);

            // Write to a non-ignored path — SHOULD trigger
            await fs.writeFile(path.join(repo.path, 'visible.txt'), 'visible');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Expected file watcher event for visible.txt').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('ignores directories matching literal patterns like /out/', async () => {
            // Setup config to return 'watch'
            host.config.set('fileWatcherMode', 'watch');

            repo.writeFile('.gitignore', '/out*/');

            const ignoredDir = path.join(repo.path, 'out');
            await fs.mkdir(ignoredDir, { recursive: true });

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for both watchers to start and settle. We wait for the op_heads watcher too
            // because it sets lastExternalOpTime, which makes hasActiveOrRecentWrites true for 500ms.
            await waitForLog('Working Copy Watcher] Started');
            await waitForLog('OpHeads Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 800));
            triggerRefreshSpy.mockClear();

            // 1. Write to the ignored directory — should NOT trigger
            await fs.writeFile(path.join(ignoredDir, 'build.log'), 'building...');

            // Wait to confirm no event fires for ignored file
            await new Promise((resolve) => setTimeout(resolve, 800));
            const ignoredCalls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(ignoredCalls, 'File in /out/ directory should not have triggered a refresh').toHaveLength(0);

            // 2. Write to a non-ignored path — SHOULD trigger.
            // IMPORTANT: Use fs.writeFile directly (not repo.writeFile) to avoid triggering
            // `jj status` (snapshot), which writes to op_heads and sets lastExternalOpTime,
            // causing hasActiveOrRecentWrites to suppress the working copy watcher callback.
            await fs.writeFile(path.join(repo.path, 'readme.md'), 'hello');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Expected file watcher event for readme.md').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('ignores secondary workspace directories', async () => {
            // Setup config to return 'watch'
            host.config.set('fileWatcherMode', 'watch');

            // Create a secondary workspace directory inside the main repo
            const secondRepo = repo.workspaceAdd('second_workspace');

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for watchers to start and settle
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 800));
            triggerRefreshSpy.mockClear();

            // Write to the secondary workspace directory - should NOT trigger
            const secondWorkspaceFile = path.join(secondRepo.path, 'somefile.txt');
            await fs.writeFile(secondWorkspaceFile, 'change');

            // Wait to confirm no event fires for secondary workspace file
            await new Promise((resolve) => setTimeout(resolve, 800));
            const ignoredCalls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(ignoredCalls, 'File in secondary workspace should not have triggered a refresh').toHaveLength(0);

            // Write to a main workspace path - SHOULD trigger
            await fs.writeFile(path.join(repo.path, 'visible.txt'), 'visible');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Expected file watcher event for visible.txt').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });
    });
});
