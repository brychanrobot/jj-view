/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { commitCommand } from '../../commands/commit';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('commitCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockJjRepo = createMock<JjRepository>({
            jj,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
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
        const uiShowErrorSpy = vi.spyOn(ctx.host.ui, 'showError').mockResolvedValue(undefined);
        vi.spyOn(mockJjRepo.jj, 'commit').mockRejectedValue(new Error('commit failed'));

        await commitCommand(ctx, { description: 'feat: error test' });

        expect(uiShowErrorSpy).toHaveBeenCalledWith(expect.any(Error), 'Error committing change');
    });

    test('refreshes the repository after a successful commit', async () => {
        await commitCommand(ctx, { description: 'feat: repo refresh' });

        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after commit' });
    });

    test('wraps commit execution in a progress UI', async () => {
        const withProgressSpy = vi.spyOn(ctx.host.ui, 'withProgress');

        await commitCommand(ctx, { description: 'feat: progress test' });

        expect(withProgressSpy).toHaveBeenCalledWith('Committing...', expect.any(Function));
    });

    test('formats description when commit.formatDescriptionOnSave is enabled', async () => {
        ctx.host.config.set('commit.formatDescriptionOnSave', true);
        ctx.host.config.set('commit.bodyWidthRuler', 20);

        repo.new(undefined, 'initial');
        const initialId = repo.getChangeId('@');

        const longMsg = 'Title\n\nThis is a long body description that should be wrapped.';
        await commitCommand(ctx, { description: longMsg });

        const committedDesc = repo.getDescription(initialId);
        expect(committedDesc.trim()).toBe('Title\n\nThis is a long body\ndescription that\nshould be wrapped.');
    });
});
