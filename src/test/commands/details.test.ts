/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { showDetailsCommand } from '../../commands/details';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjResourceState } from '../../scm-resource-state';
import { createShowDetailsPayload } from '../../vscode/payloads/details.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('showDetailsCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({ jj });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('calls vscode.openWith for the extracted revision', async () => {
        const changeId = repo.getChangeId('@');
        const payload = createShowDetailsPayload([changeId]);
        await showDetailsCommand(ctx, payload);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openWith',
            expect.objectContaining({
                scheme: 'jj-commit',
                fragment: expect.stringContaining(`changeId=${changeId}`),
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

        const payload = createShowDetailsPayload([mockGroup]);
        await showDetailsCommand(ctx, payload);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openWith',
            expect.objectContaining({
                scheme: 'jj-commit',
                fragment: expect.stringContaining(`changeId=${changeId}`),
            }),
            'jj-view.commitDetailsEditor',
        );
    });

    test('defaults to @ if no revision extracted', async () => {
        const changeId = repo.getChangeId('@');
        const payload = createShowDetailsPayload([{}]);
        await showDetailsCommand(ctx, payload);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openWith',
            expect.objectContaining({
                scheme: 'jj-commit',
                fragment: expect.stringContaining(`changeId=${changeId}`),
            }),
            'jj-view.commitDetailsEditor',
        );
    });
});
