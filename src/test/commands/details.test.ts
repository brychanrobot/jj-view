/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import { showDetailsCommand } from '../../commands/details';
import { JjLogWebviewProvider } from '../../jj-log-webview-provider';
import { JjResourceState } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('showDetailsCommand', () => {
    let mockProvider: JjLogWebviewProvider;

    beforeEach(() => {
        mockProvider = createMock<JjLogWebviewProvider>({
            createCommitDetailsPanel: vi.fn(),
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('calls createCommitDetailsPanel with revision string', async () => {
        await showDetailsCommand(mockProvider, ['somerev']);
        expect(mockProvider.createCommitDetailsPanel).toHaveBeenCalledWith('somerev');
    });

    test('calls createCommitDetailsPanel with resource group', async () => {
        const mockState = createMock<JjResourceState>({ revision: 'somerev' });
        const mockGroup = createMock<vscode.SourceControlResourceGroup>({
            id: 'parent-0',
            label: 'Parent',
            resourceStates: [mockState],
        });
        await showDetailsCommand(mockProvider, [mockGroup]);
        expect(mockProvider.createCommitDetailsPanel).toHaveBeenCalledWith('somerev');
    });

    test('does nothing if no revision extracted', async () => {
        await showDetailsCommand(mockProvider, [{}]);
        expect(mockProvider.createCommitDetailsPanel).not.toHaveBeenCalled();
    });
});
