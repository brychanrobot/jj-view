/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openMergeEditorCommand } from '../../commands/merge-editor';
import type { JjRepository } from '../../jj-repository';
import { Uri } from '../../uri-utils';
import { createOpenMergeEditorPayload } from '../../vscode/payloads/merge-editor.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { createMock } from '../test-utils';

describe('openMergeEditorCommand', () => {
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        mockJjRepo = createMock<JjRepository>({
            rootUri: Uri.file('/test'),
        });
        ctx = new FakeCommandContext(mockJjRepo);
        ctx.host.nav.openMergeEditor = vi.fn();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resources provided', async () => {
        const payload = createOpenMergeEditorPayload([undefined]);
        await openMergeEditorCommand(ctx, payload);

        expect(ctx.host.nav.openMergeEditor).not.toHaveBeenCalled();
    });

    test('calls openMergeEditor with resource states', async () => {
        const resourceUri = Uri.file('/test/foo.txt');
        const resource = { resourceUri };
        const payload = createOpenMergeEditorPayload([resource]);
        await openMergeEditorCommand(ctx, payload);

        expect(ctx.host.nav.openMergeEditor).toHaveBeenCalledWith(resourceUri);
    });

    test('handles error', async () => {
        const resourceUri = Uri.file('/test/foo.txt');
        const resource = { resourceUri };
        const openMergeEditor = ctx.host.nav.openMergeEditor;
        if (!openMergeEditor) {
            throw new Error('openMergeEditor not defined');
        }
        vi.mocked(openMergeEditor).mockRejectedValue(new Error('boom'));

        const payload = createOpenMergeEditorPayload([resource]);
        await openMergeEditorCommand(ctx, payload);

        expect(ctx.host.ui.errorMessages[0].prefix).toBe('Error opening merge editor');
    });
});
