/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as parcelWatcher from '@parcel/watcher';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DirectoryWatcher } from '../core/directory-watcher';
import type { LoggerChannel } from '../utils/output-channel';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMockLogOutputChannel } from './test-utils';

vi.mock('@parcel/watcher', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@parcel/watcher')>();
    return {
        ...actual,
        subscribe: vi.fn(actual.subscribe),
    };
});

describe('DirectoryWatcher (real @parcel/watcher)', { retry: os.platform() === 'win32' ? 3 : 0 }, () => {
    let tmpDir: string;
    let outputChannel: LoggerChannel;
    let host: FakeHostEnvironment;
    let callback: Mock;
    let watcher: DirectoryWatcher;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-test-'));
        outputChannel = createMockLogOutputChannel();
        host = new FakeHostEnvironment();
        callback = vi.fn();
        watcher = new DirectoryWatcher(tmpDir, callback, outputChannel, { name: 'DirectoryWatcher', host });
    });

    afterEach(async () => {
        await watcher.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const waitForLog = async (pattern: string, timeout = 10000) => {
        await vi.waitFor(
            () => {
                const { calls } = (outputChannel.info as Mock).mock;
                const found = calls.some((call) => call[0].includes(pattern));
                if (!found) {
                    throw new Error(`Log pattern "${pattern}" not found`);
                }
            },
            { timeout, interval: 50 },
        );
    };

    it('subscribes and logs on start', async () => {
        await watcher.start();
        await waitForLog('Started');
        expect(outputChannel.info).toHaveBeenCalledWith(expect.stringMatching(/Starting.*watcher/));
    });

    it('does not double subscribe if start is called twice', async () => {
        await watcher.start();
        await watcher.start();

        const startCalls = (outputChannel.info as Mock).mock.calls.filter((call) => /Starting.*watcher/.test(call[0]));
        expect(startCalls).toHaveLength(1);
    });

    it('detects file creation', async () => {
        await watcher.start();
        await waitForLog('Started');

        fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'hello');

        await vi.waitFor(
            () => {
                expect(callback).toHaveBeenCalled();
                const events = callback.mock.calls.flatMap((call) => call[0]);
                const hasCreate = events.some((e: { path: string; type: string }) => e.path.includes('new-file.txt'));
                expect(hasCreate, 'Expected a create event for new-file.txt').toBe(true);
            },
            { timeout: 10000, interval: 50 },
        );
    });

    it('detects file modification', async () => {
        const filePath = path.join(tmpDir, 'existing.txt');
        fs.writeFileSync(filePath, 'initial');

        await watcher.start();
        await waitForLog('Started');

        // Clear any events from watcher catching the initial file
        callback.mockClear();

        fs.writeFileSync(filePath, 'modified');

        await vi.waitFor(
            () => {
                expect(callback).toHaveBeenCalled();
                const events = callback.mock.calls.flatMap((call) => call[0]);
                const hasUpdate = events.some((e: { path: string; type: string }) => e.path.includes('existing.txt'));
                expect(hasUpdate, 'Expected an update event for existing.txt').toBe(true);
            },
            { timeout: 10000, interval: 50 },
        );
    });

    it('detects file deletion', async () => {
        await watcher.start();
        await waitForLog('Started');

        const filePath = path.join(tmpDir, 'to-delete.txt');
        fs.writeFileSync(filePath, 'bye');

        // Wait for creation first to ensure watcher is ready
        await vi.waitFor(
            () => {
                const events = callback.mock.calls.flatMap((call) => call[0]);
                const hasCreate = events.some(
                    (e: { path: string; type: string }) => e.path.includes('to-delete.txt') && e.type === 'create',
                );
                expect(hasCreate, 'Expected verify creation of to-delete.txt').toBe(true);
            },
            { timeout: 10000, interval: 50 },
        );

        callback.mockClear();

        fs.rmSync(filePath);

        await vi.waitFor(
            () => {
                expect(callback).toHaveBeenCalled();
                const events = callback.mock.calls.flatMap((call) => call[0]);
                const hasDelete = events.some(
                    (e: { path: string; type: string }) => e.path.includes('to-delete.txt') && e.type === 'delete',
                );
                expect(hasDelete, 'Expected a delete event for to-delete.txt').toBe(true);
            },
            { timeout: 10000, interval: 50 },
        );
    });

    it('ignores paths matching the ignore pattern', async () => {
        const ignoredDir = path.join(tmpDir, '.jj');
        fs.mkdirSync(ignoredDir, { recursive: true });

        await watcher.start(['.jj']);
        await waitForLog('Started');

        // Write to the ignored directory — should NOT trigger
        fs.writeFileSync(path.join(ignoredDir, 'ignored-file.txt'), 'ignored');

        // Write to a non-ignored path — SHOULD trigger
        fs.writeFileSync(path.join(tmpDir, 'visible-file.txt'), 'visible');

        await vi.waitFor(
            () => {
                const events = callback.mock.calls.flatMap((call) => call[0]);
                const hasVisible = events.some((e: { path: string }) => e.path.includes('visible-file.txt'));
                expect(hasVisible, 'Expected event for visible-file.txt').toBe(true);
            },
            { timeout: 10000, interval: 50 },
        );

        // Verify no events for the ignored file
        const allEvents = callback.mock.calls.flatMap((call) => call[0]);
        const hasIgnored = allEvents.some((e: { path: string }) => e.path.includes('ignored-file.txt'));
        expect(hasIgnored, 'Should not have received event for ignored file').toBe(false);
    });

    it('stops receiving events after stop()', async () => {
        await watcher.start();
        await waitForLog('Started');

        await watcher.stop();
        callback.mockClear();

        fs.writeFileSync(path.join(tmpDir, 'after-stop.txt'), 'nope');

        // Wait a bit to confirm no events arrive
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(callback).not.toHaveBeenCalled();
    });

    it('stops receiving events after dispose()', async () => {
        await watcher.start();
        await waitForLog('Started');

        await watcher.dispose();
        callback.mockClear();

        fs.writeFileSync(path.join(tmpDir, 'after-dispose.txt'), 'nope');

        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(callback).not.toHaveBeenCalled();
    });

    it('handles dispose during start without error', async () => {
        const startPromise = watcher.start();
        await watcher.dispose();
        await startPromise;

        // Should not throw — just gracefully clean up
        callback.mockClear();

        fs.writeFileSync(path.join(tmpDir, 'after-race.txt'), 'nope');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(callback).not.toHaveBeenCalled();
    });

    it('shows warning message and links to README on ENOSPC inotify error', async () => {
        host.ui.setNextWarningResponse('Open README');

        const fakeError = new Error("inotify_add_watch on '/some/path' failed: No space left on device (ENOSPC)");
        vi.mocked(parcelWatcher.subscribe).mockRejectedValueOnce(fakeError);

        await expect(watcher.start()).rejects.toThrow(fakeError);

        expect(host.ui.warningMessages.some((msg) => msg.includes('inotify watch limit reached'))).toBe(true);
        expect(host.nav.externalUrisOpened.map((u) => u.toString())).toContain(
            'https://github.com/brychanrobot/jj-view#file-watcher-mode',
        );
    });
});

describe('Auto-recovery and Reconnection (Fake Timers)', () => {
    let fakeTmpDir: string;
    let fakeOutputChannel: LoggerChannel;
    let fakeHost: FakeHostEnvironment;
    let fakeCallback: Mock;
    let capturedCallback: ((err: Error | null, events: parcelWatcher.Event[]) => void) | undefined;
    let mockUnsubscribe: Mock;

    beforeEach(() => {
        vi.useFakeTimers();
        fakeTmpDir = '/fake/tmp/dir';
        fakeOutputChannel = createMockLogOutputChannel();
        fakeHost = new FakeHostEnvironment();
        fakeCallback = vi.fn();
        mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
        capturedCallback = undefined;

        vi.mocked(parcelWatcher.subscribe).mockReset();
        vi.mocked(parcelWatcher.subscribe).mockImplementation(async (_dir, cb) => {
            capturedCallback = cb;
            return { unsubscribe: mockUnsubscribe };
        });
    });

    afterEach(async () => {
        vi.clearAllTimers();
        vi.useRealTimers();
        const actual = await vi.importActual<typeof import('@parcel/watcher')>('@parcel/watcher');
        vi.mocked(parcelWatcher.subscribe).mockImplementation(actual.subscribe);
    });

    it('reconnects after subscription error and invokes onReconnect', async () => {
        const onReconnectSpy = vi.fn();
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'ReconnectWatcher',
            host: fakeHost,
            onReconnect: onReconnectSpy,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        // Trigger error in subscriber callback (daemon crash / socket drop)
        capturedCallback?.(new Error('Watchman daemon disconnected'), []);

        // Old subscription should have been cleaned up
        expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

        // Virtual time 999ms: retry should not have executed yet
        await vi.advanceTimersByTimeAsync(999);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);
        expect(onReconnectSpy).not.toHaveBeenCalled();

        // Advance 1ms to reach 1000ms: retry executes
        await vi.advanceTimersByTimeAsync(1);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);
        expect(onReconnectSpy).toHaveBeenCalledTimes(1);

        await reconnectWatcher.dispose();
    });

    it('exponentially backs off retry delay and caps at maxDelay', async () => {
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'BackoffWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        // Subsequent reconnect attempts fail
        vi.mocked(parcelWatcher.subscribe).mockRejectedValue(new Error('Daemon unavailable'));

        // Initial failure
        capturedCallback?.(new Error('Watchman daemon disconnected'), []);

        // Attempt 1: 1000ms
        await vi.advanceTimersByTimeAsync(999);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        // Attempt 2: 2000ms (doubled)
        await vi.advanceTimersByTimeAsync(1999);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(3);

        // Attempt 3: 4000ms (doubled to maxDelay)
        await vi.advanceTimersByTimeAsync(3999);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(4);

        // Attempt 4: 4000ms (capped at maxDelay, not 8000ms)
        await vi.advanceTimersByTimeAsync(3999);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(5);

        await reconnectWatcher.dispose();
    });

    it('resets retry delay to initialDelay after successful reconnection', async () => {
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'ResetDelayWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        // First retry attempt fails
        vi.mocked(parcelWatcher.subscribe).mockRejectedValueOnce(new Error('Temporary fail'));

        capturedCallback?.(new Error('Disconnect 1'), []);

        // Attempt 1 at 1000ms fails
        await vi.advanceTimersByTimeAsync(1000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        // Attempt 2 at +2000ms succeeds
        vi.mocked(parcelWatcher.subscribe).mockImplementationOnce(async (_dir, cb) => {
            capturedCallback = cb;
            return { unsubscribe: mockUnsubscribe };
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(3);

        // Disconnect again; delay should be reset to 1000ms
        capturedCallback?.(new Error('Disconnect 2'), []);

        await vi.advanceTimersByTimeAsync(999);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(4);

        await reconnectWatcher.dispose();
    });

    it('stops reconnecting when stop() is called while reconnect timer is pending', async () => {
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'StopWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        capturedCallback?.(new Error('Disconnect'), []);

        await reconnectWatcher.stop();

        // Advance by a large duration; subscribe should not have been called again
        await vi.advanceTimersByTimeAsync(60000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);
    });

    it('stops reconnecting when dispose() is called while reconnect timer is pending', async () => {
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'DisposeWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        capturedCallback?.(new Error('Disconnect'), []);

        await reconnectWatcher.dispose();

        await vi.advanceTimersByTimeAsync(60000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);
    });

    it('halts cleanly without reconnecting if stopped while subscribe() is in-flight during attemptReconnect', async () => {
        const onReconnectSpy = vi.fn();
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'InFlightStopWatcher',
            host: fakeHost,
            onReconnect: onReconnectSpy,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();

        let resolveSub!: (val: { unsubscribe: Mock }) => void;
        vi.mocked(parcelWatcher.subscribe).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveSub = resolve;
                }),
        );

        capturedCallback?.(new Error('Disconnect'), []);

        // Fire timer -> attemptReconnect calls start() which hangs on subscribe
        await vi.advanceTimersByTimeAsync(1000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        // Now stop while subscribe is in flight
        const stopPromise = reconnectWatcher.stop();

        // Now resolve subscribe
        resolveSub({ unsubscribe: mockUnsubscribe });
        await stopPromise;

        await vi.advanceTimersByTimeAsync(60000);
        expect(onReconnectSpy).not.toHaveBeenCalled();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);
    });

    it('cancels pending reconnect timer if start() is called manually', async () => {
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'ManualStartWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        capturedCallback?.(new Error('Disconnect'), []);

        // Advance 500ms into the 1000ms delay
        await vi.advanceTimersByTimeAsync(500);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        // Manual start
        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        // Advance past original 1000ms mark; no extra duplicate subscribe
        await vi.advanceTimersByTimeAsync(1000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        await reconnectWatcher.dispose();
    });

    it('does not schedule duplicate timers if error fires multiple times rapidly', async () => {
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'RapidErrorWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        // Fire multiple errors in rapid succession
        capturedCallback?.(new Error('Error 1'), []);
        capturedCallback?.(new Error('Error 2'), []);
        capturedCallback?.(new Error('Error 3'), []);

        // Only one retry should happen at 1000ms
        await vi.advanceTimersByTimeAsync(1000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        await reconnectWatcher.dispose();
    });

    it('does not re-trigger reconnection if onReconnect callback throws', async () => {
        const onReconnectSpy = vi.fn().mockRejectedValue(new Error('Queue crashed'));
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'ThrowingReconnectWatcher',
            host: fakeHost,
            onReconnect: onReconnectSpy,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        capturedCallback?.(new Error('Disconnect'), []);

        // Advance 1000ms; reconnect succeeds but onReconnect throws
        await vi.advanceTimersByTimeAsync(1000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);
        expect(onReconnectSpy).toHaveBeenCalledTimes(1);

        // Error is logged and no further reconnect loops happen
        expect(fakeOutputChannel.error).toHaveBeenCalledWith(
            expect.stringContaining('Error in onReconnect callback'),
            expect.any(Error),
        );

        await vi.advanceTimersByTimeAsync(60000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        await reconnectWatcher.dispose();
    });

    it('does not auto-reconnect on ENOSPC inotify limit error and invokes onPermanentFailure', async () => {
        const onPermanentFailureSpy = vi.fn();
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'InotifyErrorWatcher',
            host: fakeHost,
            onPermanentFailure: onPermanentFailureSpy,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        capturedCallback?.(new Error("inotify_add_watch on '/some/path' failed: No space left on device (ENOSPC)"), []);

        expect(fakeHost.ui.warningMessages.some((msg) => msg.includes('inotify watch limit reached'))).toBe(true);
        expect(onPermanentFailureSpy).toHaveBeenCalledTimes(1);

        // Should not schedule any reconnect
        await vi.advanceTimersByTimeAsync(60000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        await reconnectWatcher.dispose();
    });

    it('calls onPermanentFailure and stops retrying when maxRetries is exceeded', async () => {
        const onPermanentFailureSpy = vi.fn();
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'MaxRetriesWatcher',
            host: fakeHost,
            onPermanentFailure: onPermanentFailureSpy,
            reconnectOptions: { initialDelayMs: 100, maxDelayMs: 100, maxRetries: 2 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        vi.mocked(parcelWatcher.subscribe).mockRejectedValue(new Error('Permanently dead'));

        capturedCallback?.(new Error('Disconnect'), []);

        // Attempt 1 at 100ms
        await vi.advanceTimersByTimeAsync(100);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        // Attempt 2 at +100ms
        await vi.advanceTimersByTimeAsync(100);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(3);

        // Retry count is now 2 (maxRetries reached). Attempt 3 should fail permanently
        expect(onPermanentFailureSpy).toHaveBeenCalledTimes(1);
        expect(onPermanentFailureSpy).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('Maximum reconnection attempts') }),
        );

        await vi.advanceTimersByTimeAsync(60000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(3);

        await reconnectWatcher.dispose();
    });

    it('classifies Watchman daemon max_user_watches error as inotify limit and skips reconnect', async () => {
        const onPermanentFailureSpy = vi.fn();
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'WatchmanLimitWatcher',
            host: fakeHost,
            onPermanentFailure: onPermanentFailureSpy,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        const watchmanError = new Error(
            'The user limit on the total number of inotify watches was reached; increase the fs.inotify.max_user_watches sysctl',
        );
        capturedCallback?.(watchmanError, []);

        expect(onPermanentFailureSpy).toHaveBeenCalledWith(watchmanError);
        expect(fakeHost.ui.warningMessages.some((msg) => msg.includes('inotify watch limit reached'))).toBe(true);

        // Ensure no reconnect is scheduled
        await vi.advanceTimersByTimeAsync(10000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        await reconnectWatcher.dispose();
    });

    it('handles throwing onPermanentFailure callback without unhandled exception', async () => {
        const throwingCallback = vi.fn().mockImplementation(() => {
            throw new Error('Callback boom');
        });
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'ThrowingFailureWatcher',
            host: fakeHost,
            onPermanentFailure: throwingCallback,
            reconnectOptions: { initialDelayMs: 100, maxDelayMs: 100, maxRetries: 1 },
        });

        await reconnectWatcher.start();
        capturedCallback?.(new Error('Fatal error: inotify_add_watch failed (ENOSPC)'), []);

        expect(throwingCallback).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fakeOutputChannel.error)).toHaveBeenCalledWith(
            expect.stringContaining('Error in onPermanentFailure callback'),
            expect.anything(),
        );

        await reconnectWatcher.dispose();
    });

    it('resets reconnect delay and retry count on manual start()', async () => {
        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'ManualStartWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000, maxRetries: 2 },
        });

        await reconnectWatcher.start();

        // First error: scheduled for 1000ms, backoff delay becomes 2000ms, retryCount becomes 1
        capturedCallback?.(new Error('Drop 1'), []);

        // Manually restart before reconnect timeout fires
        await reconnectWatcher.start();

        // Next error should use initial delay (1000ms), not the backed-off 2000ms
        capturedCallback?.(new Error('Drop 2'), []);

        // At 999ms, it should not have reconnected yet
        await vi.advanceTimersByTimeAsync(999);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        // At 1000ms, it reconnects!
        await vi.advanceTimersByTimeAsync(1);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(3);

        await reconnectWatcher.dispose();
    });

    it('handles synchronous throw from dead subscription unsubscribe() cleanly', async () => {
        mockUnsubscribe.mockImplementation(() => {
            throw new Error('Native unsubscribe sync crash');
        });

        const reconnectWatcher = new DirectoryWatcher(fakeTmpDir, fakeCallback, fakeOutputChannel, {
            name: 'SyncCrashWatcher',
            host: fakeHost,
            reconnectOptions: { initialDelayMs: 1000, maxDelayMs: 4000 },
        });

        await reconnectWatcher.start();
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(1);

        // Should not crash, and should schedule reconnect as expected
        capturedCallback?.(new Error('Disconnect with crashing unsubscribe'), []);

        await vi.advanceTimersByTimeAsync(1000);
        expect(parcelWatcher.subscribe).toHaveBeenCalledTimes(2);

        await reconnectWatcher.dispose();
    });
});
