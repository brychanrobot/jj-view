/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { handleTerminalExecution } from '../extension';
import type { GerritService } from '../gerrit-service';
import type * as vscode from 'vscode';

describe('handleTerminalExecution', () => {
    let gerritService: { forceRefresh: ReturnType<typeof vi.fn> };
    let outputChannel: { appendLine: ReturnType<typeof vi.fn> };
    let scheduledCallbacks: { callback: () => void; delay: number }[];
    let scheduleFn: (callback: () => void, delay: number) => void;

    beforeEach(() => {
        gerritService = { forceRefresh: vi.fn() };
        outputChannel = { appendLine: vi.fn() };
        scheduledCallbacks = [];
        scheduleFn = (callback, delay) => scheduledCallbacks.push({ callback, delay });
    });

    it('detects "jj upload" and schedules staggered refreshes', () => {
        const result = handleTerminalExecution(
            'jj upload',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
            scheduleFn,
        );

        expect(result).toBe(true);
        expect(scheduledCallbacks).toHaveLength(4);
        expect(scheduledCallbacks.map(s => s.delay)).toEqual([2000, 3000, 5000, 10000]);

        // Execute all scheduled callbacks
        for (const { callback } of scheduledCallbacks) {
            callback();
        }
        expect(gerritService.forceRefresh).toHaveBeenCalledTimes(4);
    });

    it('detects "jj gerrit upload" with arguments', () => {
        const result = handleTerminalExecution(
            'jj gerrit upload --change abc123',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
            scheduleFn,
        );

        expect(result).toBe(true);
        expect(scheduledCallbacks).toHaveLength(4);
    });

    it('ignores non-jj commands', () => {
        const result = handleTerminalExecution(
            'git push origin main',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
            scheduleFn,
        );

        expect(result).toBe(false);
        expect(scheduledCallbacks).toHaveLength(0);
        expect(gerritService.forceRefresh).not.toHaveBeenCalled();
    });

    it('ignores jj commands without upload', () => {
        const result = handleTerminalExecution(
            'jj log --revisions @',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
            scheduleFn,
        );

        expect(result).toBe(false);
        expect(scheduledCallbacks).toHaveLength(0);
    });

    it('handles leading whitespace in command', () => {
        const result = handleTerminalExecution(
            '  jj upload  ',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
            scheduleFn,
        );

        expect(result).toBe(true);
        expect(scheduledCallbacks).toHaveLength(4);
    });

    it('logs detected upload command', () => {
        handleTerminalExecution(
            'jj upload',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
            scheduleFn,
        );

        expect(outputChannel.appendLine).toHaveBeenCalledWith(
            '[Extension] Detected terminal upload: "jj upload"'
        );
    });
});
