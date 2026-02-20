/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock, asMock } from '../test-utils';
import { refreshCommand } from '../../commands/refresh';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('refreshCommand', () => {
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('calls refresh successfully', async () => {
        await refreshCommand(scmProvider);
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('handles refresh error', async () => {
        asMock(scmProvider.refresh).mockRejectedValue(new Error('refresh failed'));
        await refreshCommand(scmProvider);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Error refreshing: refresh failed'),
            'Show Log'
        );
    });
});
