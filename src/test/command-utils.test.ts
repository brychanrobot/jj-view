/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { withDelayedProgress } from '../commands/command-utils';

// Mock vscode
vi.mock('vscode', () => ({
    window: {
        withProgress: vi.fn().mockImplementation(async (_, task) => {
            return task();
        }),
    },
    ProgressLocation: {
        Notification: 15,
    },
}));

describe('withDelayedProgress', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should return the result of the promise', async () => {
        const result = await withDelayedProgress('Title', Promise.resolve('success'));
        expect(result).toBe('success');
    });

    it('should propagate errors', async () => {
        const error = new Error('fail');
        await expect(withDelayedProgress('Title', Promise.reject(error))).rejects.toThrow('fail');
    });

    it('should NOT show progress if task is fast (<100ms)', async () => {
        const fastTask = Promise.resolve('done');
        
        const promise = withDelayedProgress('Fast Task', fastTask);
        
        // Fast forward less than delay
        vi.advanceTimersByTime(50);
        
        await promise;
        
        expect(vscode.window.withProgress).not.toHaveBeenCalled();
    });

    it('should show progress if task is slow (>100ms)', async () => {
        let resolveTask: (value: string) => void;
        const slowTask = new Promise<string>((resolve) => {
            resolveTask = resolve;
        });

        const promise = withDelayedProgress('Slow Task', slowTask);

        // Advance past the delay
        vi.advanceTimersByTime(150);

        expect(vscode.window.withProgress).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Slow Task' }),
            expect.any(Function)
        );

        resolveTask!('finally done');
        await promise;
    });
});
