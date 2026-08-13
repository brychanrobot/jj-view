/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { commitCommand } from '../../commands/commit';
import type { CommentsManager } from '../../comments-manager';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import type { JjLoggerChannel } from '../../utils/output-channel';
import { VSCodeCommandContext } from '../../vscode/vscode-command-context';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock();
});

describe('commitCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: VSCodeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
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

    test('commits change successfully with empty description', async () => {
        repo.new(undefined, 'initial');
        const initialId = repo.getChangeId('@');

        await commitCommand(ctx, { description: '   ' });

        const oldChangeDesc = repo.getDescription(initialId);
        expect(oldChangeDesc.trim()).toBe('');

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');
    });

    test('commits change successfully', async () => {
        repo.new(undefined, 'initial');
        const initialId = repo.getChangeId('@');

        await commitCommand(ctx, { description: 'feat: my change' });

        const oldChangeDesc = repo.getDescription(initialId);
        expect(oldChangeDesc.trim()).toBe('feat: my change');

        const currentDesc = repo.getDescription('@');
        expect(currentDesc.trim()).toBe('');
    });

    test('shows an error when jj.commit rejects', async () => {
        const uiShowErrorSpy = vi.spyOn(ctx.ui, 'showError').mockResolvedValue(undefined);
        vi.spyOn(mockJjRepo.jj, 'commit').mockRejectedValue(new Error('commit failed'));

        await commitCommand(ctx, { description: 'feat: error test' });

        expect(uiShowErrorSpy).toHaveBeenCalledWith(expect.any(Error), 'Error committing change');
    });

    test('refreshes the repository after a successful commit', async () => {
        await commitCommand(ctx, { description: 'feat: repo refresh' });

        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('wraps commit execution in a progress UI', async () => {
        const withProgressSpy = vi.spyOn(ctx.ui, 'withProgress');

        await commitCommand(ctx, { description: 'feat: progress test' });

        expect(withProgressSpy).toHaveBeenCalledWith('Committing...', expect.any(Function));
    });

    test('formats description when commit.formatDescriptionOnSave is enabled', async () => {
        vi.spyOn(ctx.config, 'get').mockImplementation((key: string) => {
            if (key === 'commit.formatDescriptionOnSave') {
                return true;
            }
            if (key === 'commit.bodyWidthRuler') {
                return 20;
            }
            return undefined;
        });

        repo.new(undefined, 'initial');
        const initialId = repo.getChangeId('@');

        const longMsg = 'Title\n\nThis is a long body description that should be wrapped.';
        await commitCommand(ctx, { description: longMsg });

        const committedDesc = repo.getDescription(initialId);
        expect(committedDesc.trim()).toBe('Title\n\nThis is a long body\ndescription that\nshould be wrapped.');
    });
});
