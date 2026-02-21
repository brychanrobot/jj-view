/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { Poller } from '../poller';

describe('Poller', () => {
    let callback: Mock<() => Promise<void>>;
    let poller: Poller;

    beforeEach(() => {
        vi.useFakeTimers();
        callback = vi.fn().mockResolvedValue(undefined);
        poller = new Poller(100, callback);
    });

    afterEach(() => {
        poller.dispose();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('does not run callback immediately on start', () => {
        poller.start();
        expect(callback).not.toHaveBeenCalled();
    });

    it('runs callback after interval', async () => {
        poller.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('runs callback repeatedly', async () => {
        poller.start();
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(3);
    });

    it('stops polling when stop is called', async () => {
        poller.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(1);

        poller.stop();
        await vi.advanceTimersByTimeAsync(200);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('runs immediately if immediate flag is set in start', async () => {
        poller.start(true);
        // Should run after micro-delay (10ms)
        await vi.advanceTimersByTimeAsync(10);
        expect(callback).toHaveBeenCalledTimes(1);
        
        // And then continue polling
        await vi.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(2);
    });

    it('force runs immediately and resets timer', async () => {
        poller.start();
        
        // Advance half way
        await vi.advanceTimersByTimeAsync(50);
        expect(callback).not.toHaveBeenCalled();

        poller.force();
        expect(callback).toHaveBeenCalledTimes(1);

        // Should wait full interval from now (100ms), so 50ms more + 50ms = 100ms
        await vi.advanceTimersByTimeAsync(50);
        expect(callback).toHaveBeenCalledTimes(1);
        
        await vi.advanceTimersByTimeAsync(50);
        expect(callback).toHaveBeenCalledTimes(2);
    });

    it('does not run if disposed', async () => {
        poller.start();
        poller.dispose();
        await vi.advanceTimersByTimeAsync(200);
        expect(callback).not.toHaveBeenCalled();
    });

    it('does not double schedule if start called twice', async () => {
        poller.start();
        poller.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(1);
    });
});
