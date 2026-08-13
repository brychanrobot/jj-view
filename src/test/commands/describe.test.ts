/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import { setDescriptionCommand } from '../../commands/describe';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import type { JjScmProvider } from '../../jj-scm-provider';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { createSetDescriptionPayload } from '../../vscode/payloads/describe.payload';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock, createMockLogOutputChannel } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('setDescriptionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
    let mockJjRepo: JjRepository;
    let scmProvider: JjScmProvider;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
            sourceControl: createMock<vscode.SourceControl>({
                inputBox: createMock<vscode.SourceControlInputBox>({ value: '' }),
            }),
            outputChannel: createMockLogOutputChannel({ appendLine: vi.fn() }),
        });
        ctx = new VSCodeCommandContext(
            mockJjRepo,
            createMock<JjLoggerChannel>(NO_OP_LOGGER),
            createMock<CommentsManager>({}),
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    const runSetDescription = async (args: unknown[]) => {
        const payload = createSetDescriptionPayload(args, scmProvider);
        return await setDescriptionCommand(ctx, payload);
    };

    test('updates description from string argument', async () => {
        const result = await runSetDescription(['new description']);
        expect(result).toBe('new description');
        const description = repo.getDescription('@');
        expect(description.trim()).toBe('new description');
    });

    test('updates description from input box when message is omitted', async () => {
        scmProvider.sourceControl.inputBox.value = 'from input box';
        const result = await runSetDescription([]);
        expect(result).toBe('from input box');
        const description = repo.getDescription('@');
        expect(description.trim()).toBe('from input box');
    });

    test('allows empty descriptions when invoked from input box', async () => {
        scmProvider.sourceControl.inputBox.value = '   ';
        const result = await runSetDescription([]);
        expect(result).toBe('');
        const description = repo.getDescription('@');
        expect(description.trim()).toBe('');
    });

    test('updates description for specific revision', async () => {
        repo.new([], 'child');
        const result = await runSetDescription(['updated parent', '@-']);
        expect(result).toBe('updated parent');
        const description = repo.getDescription('@-');
        expect(description.trim()).toBe('updated parent');
    });

    test('clears description for a non-working-copy commit when provided an empty message', async () => {
        repo.new([], 'child');
        jj.describe('parent description', '@-');
        jj.describe('working copy description', '@');
        scmProvider.sourceControl.inputBox.value = 'fallback description';

        const result = await runSetDescription(['   ', '@-']);
        expect(result).toBe('');
        const description = repo.getDescription('@-');
        expect(description.trim()).toBe('');

        expect(repo.getDescription('@').trim()).toBe('working copy description');
    });

    test('returns false on jj describe failure', async () => {
        const result = await runSetDescription(['description', 'invalid_rev']);
        expect(result).toBe(false);
    });

    test('allows omitting description for non-@ revision, setting an empty description', async () => {
        repo.new([], 'child');
        await jj.describe('original parent description', '@-');
        const result = await setDescriptionCommand(ctx, { revision: '@-' });
        expect(result).toBe('');
        expect(repo.getDescription('@-').trim()).toBe('');
    });
});
