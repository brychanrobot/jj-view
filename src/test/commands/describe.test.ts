/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setDescriptionCommand } from '../../core/commands/describe';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('setDescriptionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
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

    test('updates description from description payload', async () => {
        const result = await setDescriptionCommand(ctx, { description: 'new description' });
        expect(result).toBe('new description');
        const description = repo.getDescription('@');
        expect(description.trim()).toBe('new description');
        expect(mockJjRepo.refresh).toHaveBeenCalledWith({ reason: 'after describe' });
    });

    test('updates description with empty string when empty message is provided', async () => {
        const result = await setDescriptionCommand(ctx, { description: '   ' });
        expect(result).toBe('');
        const description = repo.getDescription('@');
        expect(description.trim()).toBe('');
    });

    test('updates description for specific revision', async () => {
        repo.new([], 'child');
        const result = await setDescriptionCommand(ctx, { description: 'updated parent', revision: '@-' });
        expect(result).toBe('updated parent');
        const description = repo.getDescription('@-');
        expect(description.trim()).toBe('updated parent');
    });

    test('clears description for a non-working-copy commit when provided an empty message', async () => {
        repo.new([], 'child');
        jj.describe('parent description', '@-');
        jj.describe('working copy description', '@');

        const result = await setDescriptionCommand(ctx, { description: '   ', revision: '@-' });
        expect(result).toBe('');
        const description = repo.getDescription('@-');
        expect(description.trim()).toBe('');

        expect(repo.getDescription('@').trim()).toBe('working copy description');
    });

    test('returns false on jj describe failure', async () => {
        const result = await setDescriptionCommand(ctx, { description: 'description', revision: 'invalid_rev' });
        expect(result).toBe(false);
    });

    test('allows omitting description for non-@ revision, setting an empty description', async () => {
        repo.new([], 'child');
        await jj.describe('original parent description', '@-');
        const result = await setDescriptionCommand(ctx, { revision: '@-' });
        expect(result).toBe('');
        expect(repo.getDescription('@-').trim()).toBe('');
    });

    test('formats description on save according to ruler', async () => {
        ctx.host.config.set('commit.formatDescriptionOnSave', true);
        ctx.host.config.set('commit.bodyWidthRuler', 20);

        const longMsg = 'Title\n\nThis is a very long line in the body that will be wrapped by the formatter.';
        const result = await setDescriptionCommand(ctx, { description: longMsg, revision: '@' });

        expect(result).toBe('Title\n\nThis is a very long\nline in the body\nthat will be wrapped\nby the formatter.');
        expect(repo.getDescription('@').trim()).toBe(
            'Title\n\nThis is a very long\nline in the body\nthat will be wrapped\nby the formatter.',
        );
    });
});
