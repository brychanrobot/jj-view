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
    let gerritService: { forceRefresh: ReturnType<typeof vi.fn>; requestRefreshWithBackoffs: ReturnType<typeof vi.fn> };
    let outputChannel: { appendLine: ReturnType<typeof vi.fn> };


    beforeEach(() => {
        gerritService = { 
            forceRefresh: vi.fn(),
            requestRefreshWithBackoffs: vi.fn(),
        };
        outputChannel = { appendLine: vi.fn() };
    });

    it('detects "jj upload" and schedules staggered refreshes', () => {
        const result = handleTerminalExecution(
            'jj upload',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
        );

        expect(result).toBe(true);

        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
    });

    it('detects "jj gerrit upload" with arguments', () => {
        const result = handleTerminalExecution(
            'jj gerrit upload --change abc123',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
        );

        expect(result).toBe(true);
        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
    });

    it('ignores non-jj commands', () => {
        const result = handleTerminalExecution(
            'git push origin main',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
        );

        expect(result).toBe(false);
        expect(gerritService.requestRefreshWithBackoffs).not.toHaveBeenCalled();
        expect(gerritService.forceRefresh).not.toHaveBeenCalled();
    });

    it('ignores jj commands without upload', () => {
        const result = handleTerminalExecution(
            'jj log --revisions @',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
        );

        expect(result).toBe(false);
        expect(gerritService.requestRefreshWithBackoffs).not.toHaveBeenCalled();
    });

    it('handles leading whitespace in command', () => {
        const result = handleTerminalExecution(
            '  jj upload  ',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
        );

        expect(result).toBe(true);
        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
    });

    it('logs detected upload command', () => {
        handleTerminalExecution(
            'jj upload',
            gerritService as unknown as GerritService,
            outputChannel as unknown as vscode.OutputChannel,
        );

        expect(outputChannel.appendLine).toHaveBeenCalledWith(
            '[Extension] Detected terminal upload: "jj upload"'
        );
    });
});
