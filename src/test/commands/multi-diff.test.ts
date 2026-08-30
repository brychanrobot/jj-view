/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showMultiFileDiffCommand } from '../../core/commands/multi-diff';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('showMultiFileDiffCommand', () => {
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

    it('opens multi-diff with correct 3-tuple URIs using change ID', async () => {
        const FILE_NAME = 'file1.txt';
        repo.writeFile(FILE_NAME, 'content 1');
        repo.describe('test commit description');
        const changeId = repo.getChangeId('@');

        await showMultiFileDiffCommand(ctx, { revision: changeId });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const multiDiff = ctx.host.nav.multiDiffsOpened[0];

        // Title should include short change ID and description
        expect(multiDiff.title).toContain(changeId.slice(0, 8));
        expect(multiDiff.title).toContain('test commit description');

        const { resources } = multiDiff;
        expect(resources).toHaveLength(1);

        const { label, leftUri: original, rightUri: modified } = resources[0];

        // Label should be the modified URI (display identifier)
        expect(label).toContain(FILE_NAME);

        // Original (left) should reference parent revision
        expect(original.scheme).toBe('jj-view');
        expect(original.fragment).toContain(`base=${changeId}`);
        expect(original.fragment).toContain('side=left');
        expect(original.path).toContain(FILE_NAME);

        // Modified (right) should use jj-edit scheme (editable for mutable commits)
        expect(modified.scheme).toBe('jj-edit');
        expect(modified.fragment).toContain(`revision=${changeId}`);
        expect(modified.path).toContain(FILE_NAME);
    });

    it('resolves @ to change ID', async () => {
        repo.writeFile('file.txt', 'content');
        const changeId = repo.getChangeId('@');

        await showMultiFileDiffCommand(ctx, { revision: '@' });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const multiDiff = ctx.host.nav.multiDiffsOpened[0];
        const modified = multiDiff.resources[0].rightUri;
        expect(modified.scheme).toBe('jj-edit');
        expect(modified.fragment).toContain(`revision=${changeId}`);
    });

    it('shows info message when no changes found', async () => {
        await showMultiFileDiffCommand(ctx, { revision: '@' });

        expect(ctx.host.ui.infoMessages[0]).toContain('No changes found in revision');
        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(0);
    });
});
