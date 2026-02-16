/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { DirectoryWatcher } from '../directory-watcher';
import { createMock } from './test-utils';
import type { OutputChannel } from 'vscode';

describe('DirectoryWatcher (real @parcel/watcher)', () => {
    let tmpDir: string;
    let outputChannel: OutputChannel;
    let callback: Mock;
    let watcher: DirectoryWatcher;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-test-'));
        outputChannel = createMock<OutputChannel>({
            appendLine: vi.fn(),
        });
        callback = vi.fn();
        watcher = new DirectoryWatcher(tmpDir, callback, outputChannel);
    });

    afterEach(async () => {
        await watcher.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const waitForLog = async (pattern: string, timeout = 3000) => {
        await vi.waitFor(() => {
            const calls = (outputChannel.appendLine as Mock).mock.calls;
            const found = calls.some(call => call[0].includes(pattern));
            if (!found) {
                throw new Error(`Log pattern "${pattern}" not found`);
            }
        }, { timeout, interval: 50 });
    };

    it('subscribes and logs on start', async () => {
        await watcher.start();
        await waitForLog('Started');
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Starting watcher'));
    });

    it('does not double subscribe if start is called twice', async () => {
        await watcher.start();
        await watcher.start();

        const startCalls = (outputChannel.appendLine as Mock).mock.calls
            .filter(call => call[0].includes('Starting watcher'));
        expect(startCalls).toHaveLength(1);
    });

    it('detects file creation', async () => {
        await watcher.start();
        await waitForLog('Started');

        fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'hello');

        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalled();
            const events = callback.mock.calls.flatMap(call => call[0]);
            const hasCreate = events.some(
                (e: { path: string; type: string }) => e.path.includes('new-file.txt')
            );
            expect(hasCreate, 'Expected a create event for new-file.txt').toBe(true);
        }, { timeout: 3000, interval: 50 });
    });

    it('detects file modification', async () => {
        const filePath = path.join(tmpDir, 'existing.txt');
        fs.writeFileSync(filePath, 'initial');

        await watcher.start();
        await waitForLog('Started');

        // Clear any events from watcher catching the initial file
        callback.mockClear();

        fs.writeFileSync(filePath, 'modified');

        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalled();
            const events = callback.mock.calls.flatMap(call => call[0]);
            const hasUpdate = events.some(
                (e: { path: string; type: string }) => e.path.includes('existing.txt')
            );
            expect(hasUpdate, 'Expected an update event for existing.txt').toBe(true);
        }, { timeout: 3000, interval: 50 });
    });

    it('detects file deletion', async () => {
        const filePath = path.join(tmpDir, 'to-delete.txt');
        fs.writeFileSync(filePath, 'bye');

        await watcher.start();
        await waitForLog('Started');

        callback.mockClear();

        fs.rmSync(filePath);

        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalled();
            const events = callback.mock.calls.flatMap(call => call[0]);
            const hasDelete = events.some(
                (e: { path: string; type: string }) => e.path.includes('to-delete.txt')
            );
            expect(hasDelete, 'Expected a delete event for to-delete.txt').toBe(true);
        }, { timeout: 3000, interval: 50 });
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

        await vi.waitFor(() => {
            const events = callback.mock.calls.flatMap(call => call[0]);
            const hasVisible = events.some(
                (e: { path: string }) => e.path.includes('visible-file.txt')
            );
            expect(hasVisible, 'Expected event for visible-file.txt').toBe(true);
        }, { timeout: 3000, interval: 50 });

        // Verify no events for the ignored file
        const allEvents = callback.mock.calls.flatMap(call => call[0]);
        const hasIgnored = allEvents.some(
            (e: { path: string }) => e.path.includes('ignored-file.txt')
        );
        expect(hasIgnored, 'Should not have received event for ignored file').toBe(false);
    });

    it('stops receiving events after stop()', async () => {
        await watcher.start();
        await waitForLog('Started');

        await watcher.stop();
        callback.mockClear();

        fs.writeFileSync(path.join(tmpDir, 'after-stop.txt'), 'nope');

        // Wait a bit to confirm no events arrive
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(callback).not.toHaveBeenCalled();
    });

    it('stops receiving events after dispose()', async () => {
        await watcher.start();
        await waitForLog('Started');

        await watcher.dispose();
        callback.mockClear();

        fs.writeFileSync(path.join(tmpDir, 'after-dispose.txt'), 'nope');

        await new Promise(resolve => setTimeout(resolve, 500));
        expect(callback).not.toHaveBeenCalled();
    });

    it('handles dispose during start without error', async () => {
        const startPromise = watcher.start();
        await watcher.dispose();
        await startPromise;

        // Should not throw — just gracefully clean up
        callback.mockClear();

        fs.writeFileSync(path.join(tmpDir, 'after-race.txt'), 'nope');
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(callback).not.toHaveBeenCalled();
    });
});
