/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { discardChangeCommand } from '../../commands/discard-change';
import type { JjRepository } from '../../jj-repository';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('discardChangeCommand', () => {
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
            rootUri: Uri.file(repo.path),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('returns early with invalid arguments', async () => {
        const fileName = 'invalid.txt';
        repo.writeFile(fileName, 'content\n');

        const fileUri = Uri.file(path.join(repo.path, fileName));

        // Test with null uri
        await discardChangeCommand(ctx, { uri: null as unknown as Uri, changes: [], index: 0 });
        expect(ctx.host.documents.savedUris).toHaveLength(0);

        // Test with invalid index
        await discardChangeCommand(ctx, { uri: fileUri, changes: [], index: 0 });
        expect(ctx.host.documents.savedUris).toHaveLength(0);

        // Test with non-array changes
        await discardChangeCommand(ctx, { uri: fileUri, changes: 'invalid', index: 0 });
        expect(ctx.host.documents.savedUris).toHaveLength(0);
    });

    test('validates LineChange structure', async () => {
        const fileName = 'validate.txt';
        repo.writeFile(fileName, 'content\n');

        const fileUri = Uri.file(path.join(repo.path, fileName));

        // Invalid change object (missing properties)
        const invalidChanges = [{ originalStartLineNumber: 1 }];
        await discardChangeCommand(ctx, { uri: fileUri, changes: invalidChanges, index: 0 });
        expect(ctx.host.documents.savedUris).toHaveLength(0);
    });

    test('discards change for parent content', async () => {
        const fileName = 'discard.txt';

        repo.writeFile(fileName, 'original\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'modified\n');

        const fileUri = Uri.file(path.join(repo.path, fileName));

        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 1,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
        ];

        await discardChangeCommand(ctx, { uri: fileUri, changes, index: 0 });

        expect(ctx.host.documents.savedUris).toContain(fileUri);
    });

    test('handles deletion discard (empty modified range)', async () => {
        const fileName = 'deletion.txt';
        repo.writeFile(fileName, 'keep\ndelete\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'keep\n');

        const fileUri = Uri.file(path.join(repo.path, fileName));

        // LineChange for a deletion: modifiedEndLineNumber < modifiedStartLineNumber
        const changes = [
            {
                originalStartLineNumber: 2,
                originalEndLineNumber: 2,
                modifiedStartLineNumber: 2,
                modifiedEndLineNumber: 0,
            },
        ];

        await discardChangeCommand(ctx, { uri: fileUri, changes, index: 0 });

        expect(ctx.host.documents.savedUris).toContain(fileUri);
    });

    test('handles addition discard (empty original range)', async () => {
        const fileName = 'addition.txt';
        repo.writeFile(fileName, 'line1\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'line1\nline2\n');

        const fileUri = Uri.file(path.join(repo.path, fileName));

        // LineChange for an addition: originalEndLineNumber < originalStartLineNumber
        const changes = [
            {
                originalStartLineNumber: 2,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 2,
                modifiedEndLineNumber: 2,
            },
        ];

        await discardChangeCommand(ctx, { uri: fileUri, changes, index: 0 });

        expect(ctx.host.documents.savedUris).toContain(fileUri);
    });
});
