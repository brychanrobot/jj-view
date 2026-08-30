/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareFileWithRevisionCommand } from '../../core/commands/compare-file-with-revision';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('compareFileWithRevisionCommand', () => {
    let jj: JjService;
    let repo: TestRepo;
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

    it('opens diff comparing right clicked file', async () => {
        repo.writeFile('file1.txt', 'content');
        const fileUri = Uri.file(`${repo.path}/file1.txt`);

        ctx.host.ui.setNextRevisionPromptResponse('main');

        await compareFileWithRevisionCommand(ctx, { fileUri });

        expect(ctx.host.nav.diffsOpened).toHaveLength(1);
        const diff = ctx.host.nav.diffsOpened[0];
        expect(diff.leftUri.scheme).toBe('jj-view');
        expect(diff.leftUri.fragment).toContain('revision=main');
        expect(diff.rightUri).toEqual(fileUri);
        expect(diff.title).toBe('file1.txt (main ↔ Working Copy)');
    });
});
