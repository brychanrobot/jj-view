/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { showDetailsCommand } from '../../commands/details';
import { JjService } from '../../jj-service';
import type { JjResourceState } from '../../scm-resource-state';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('showDetailsCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockOutputChannel: vscode.OutputChannel;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);
        mockOutputChannel = createMock<vscode.OutputChannel>({ appendLine: vi.fn(), show: vi.fn() });
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('calls vscode.openWith for the extracted revision', async () => {
        const changeId = repo.getChangeId('@');
        await showDetailsCommand(jj, mockOutputChannel, [changeId]);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openWith',
            expect.objectContaining({
                scheme: 'jj-commit',
                query: expect.stringContaining(`changeId=${changeId}`),
            }),
            'jj-view.commitDetailsEditor',
        );
    });

    test('calls vscode.openWith with resource state revision', async () => {
        const changeId = repo.getChangeId('@');
        const mockState = createMock<JjResourceState>({ revision: changeId });
        const mockGroup = createMock<vscode.SourceControlResourceGroup>({
            id: 'ancestor-0',
            label: 'Parent',
            resourceStates: [mockState],
        });

        await showDetailsCommand(jj, mockOutputChannel, [mockGroup]);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openWith',
            expect.objectContaining({
                scheme: 'jj-commit',
                query: expect.stringContaining(`changeId=${changeId}`),
            }),
            'jj-view.commitDetailsEditor',
        );
    });

    test('defaults to @ if no revision extracted', async () => {
        const changeId = repo.getChangeId('@');
        await showDetailsCommand(jj, mockOutputChannel, [{}]);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openWith',
            expect.objectContaining({
                scheme: 'jj-commit',
                query: expect.stringContaining(`changeId=${changeId}`),
            }),
            'jj-view.commitDetailsEditor',
        );
    });
});
