/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// sort-imports-ignore (needed so that we can import after `vscode` is mocked)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { handleTerminalExecution } from '../extension';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

// Import after mock
import type { GerritService } from '../gerrit-service';
import type { JjScmProvider } from '../jj-scm-provider';
import { createMock } from './test-utils';

describe('handleTerminalExecution', () => {
    let gerritService: GerritService;
    let outputChannel: vscode.OutputChannel;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        gerritService = createMock<GerritService>({
            forceRefresh: vi.fn(),
            requestRefreshWithBackoffs: vi.fn(),
        });
        outputChannel = createMock<vscode.OutputChannel>({ appendLine: vi.fn() });
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn().mockResolvedValue(undefined),
        });
    });

    it('detects "jj upload" and schedules staggered refreshes', () => {
        const result = handleTerminalExecution('jj upload', gerritService, outputChannel, scmProvider);

        expect(result).toBe(true);
        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('detects "jj gerrit upload" with arguments', () => {
        const result = handleTerminalExecution(
            'jj gerrit upload --change abc123',
            gerritService,
            outputChannel,
            scmProvider,
        );

        expect(result).toBe(true);
        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('ignores non-jj commands', () => {
        const result = handleTerminalExecution('git push origin main', gerritService, outputChannel, scmProvider);

        expect(result).toBe(false);
        expect(gerritService.requestRefreshWithBackoffs).not.toHaveBeenCalled();
        expect(gerritService.forceRefresh).not.toHaveBeenCalled();
    });

    it('ignores jj commands without upload', () => {
        const result = handleTerminalExecution('jj log --revisions @', gerritService, outputChannel, scmProvider);

        expect(result).toBe(false);
        expect(gerritService.requestRefreshWithBackoffs).not.toHaveBeenCalled();
    });

    it('handles leading whitespace in command', () => {
        const result = handleTerminalExecution('  jj upload  ', gerritService, outputChannel, scmProvider);

        expect(result).toBe(true);
        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('logs detected upload command', () => {
        handleTerminalExecution('jj upload', gerritService, outputChannel, scmProvider);

        expect(outputChannel.appendLine).toHaveBeenCalledWith('[Extension] Detected terminal upload: "jj upload"');
    });
});
