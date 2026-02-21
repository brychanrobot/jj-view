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

    test('suggests configuration when upload fails and no custom command set', async () => {
        mockConfig.get.mockReturnValue(undefined);
        const error = new Error('upload failed');
        vi.mocked(jjService.upload).mockRejectedValue(error);
        
        // Use a typed alias to help Vitest pick the right overload
        const showErrorMessage = vscode.window.showErrorMessage as (
            message: string,
            ...items: string[]
        ) => Thenable<string | undefined>;
        vi.mocked(showErrorMessage).mockResolvedValue('Configure Upload...');

        await uploadCommand(jjService, gerritService, 'rev-123', mockOutputChannel);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Upload failed: upload failed'),
            'Show Log',
            'Configure Upload...'
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.action.openSettings',
            'jj-view.uploadCommand'
        );
    });

    test('does not suggest configuration when custom command is already set', async () => {
        mockConfig.get.mockImplementation((key: string) => {
            if (key === 'uploadCommand') return 'custom-cmd';
            return undefined;
        });
        const error = new Error('upload failed');
        vi.mocked(jjService.upload).mockRejectedValue(error);
        
        const showErrorMessage = vscode.window.showErrorMessage as (
            message: string,
            ...items: string[]
        ) => Thenable<string | undefined>;
        vi.mocked(showErrorMessage).mockResolvedValue('Show Log');

        await uploadCommand(jjService, gerritService, 'rev-123', mockOutputChannel);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Upload failed: upload failed'),
            'Show Log'
            // No "Configure Upload..." button
        );
        // Verify it wasn't called with the extra button
        const calls = vi.mocked(vscode.window.showErrorMessage).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall).not.toContain('Configure Upload...');
    });
});
