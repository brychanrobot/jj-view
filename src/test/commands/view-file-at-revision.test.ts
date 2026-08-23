/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewFileAtRevisionCommand } from '../../commands/view-file-at-revision';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('viewFileAtRevisionCommand', () => {
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

    it('opens file with jj-view uri for target file and revision', async () => {
        repo.writeFile('file1.txt', 'content');
        const fileUri = Uri.file(`${repo.path}/file1.txt`);

        ctx.host.ui.setNextRevisionPromptResponse('main');

        await viewFileAtRevisionCommand(ctx, { fileUri });

        expect(ctx.host.nav.filesOpened).toHaveLength(1);
        const targetUri = ctx.host.nav.filesOpened[0];
        expect(targetUri.scheme).toBe('jj-view');
        expect(targetUri.fragment).toContain('revision=main');
        expect(targetUri.path).toBe('/file1.txt');
    });
});
