/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { uploadCommand } from '../../commands/upload';
import { JjService } from '../../jj-service';
import { GerritService } from '../../gerrit-service';
import * as vscode from 'vscode';

// Mock dependencies
const mockConfig = {
    get: vi.fn(),
};

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        workspace: {
            getConfiguration: vi.fn((section) => {
                if (section === 'jj-view') return mockConfig;
                return { get: vi.fn() };
            }),
        },
    });
});

describe('uploadCommand', () => {
    let jjService: JjService;

    let gerritService: GerritService;
    let mockOutputChannel: vscode.OutputChannel;

    beforeEach(() => {
        jjService = { upload: vi.fn() } as unknown as JjService;
        gerritService = { 
            isGerrit: vi.fn().mockResolvedValue(false),
            requestRefreshWithBackoffs: vi.fn()
        } as unknown as GerritService;
        mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;
        mockConfig.get.mockReset();
    });

    test('uses custom upload command when configured (correctly)', async () => {
        // Setup config to return 'git push --force' ONLY when queried for 'uploadCommand'
        // The current bug queries 'jj-view.uploadCommand', which should return undefined here
        mockConfig.get.mockImplementation((key: string) => {
            if (key === 'uploadCommand') return 'git push --force';
            return undefined;
        });

        await uploadCommand(jjService, gerritService, 'rev-123', mockOutputChannel);

        // Should use the custom command
        expect(jjService.upload).toHaveBeenCalledWith(['git', 'push', '--force'], 'rev-123');
        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
    });

    test('falls back to default when custom command is empty', async () => {
        mockConfig.get.mockReturnValue(undefined);
        
        await uploadCommand(jjService, gerritService, 'rev-123', mockOutputChannel);
        
        // Default for non-Gerrit is git push
        expect(jjService.upload).toHaveBeenCalledWith(['git', 'push'], 'rev-123');
        expect(gerritService.requestRefreshWithBackoffs).toHaveBeenCalled();
    });
});
