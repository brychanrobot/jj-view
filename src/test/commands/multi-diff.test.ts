/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showMultiFileDiffCommand } from '../../core/commands/multi-diff';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
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

    afterEach(async () => {
        await repo.dispose();
        vi.clearAllMocks();
    });

    it('opens multi-diff with correct 3-tuple URIs for working copy change ID', async () => {
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

        // Modified (right) should use file scheme for working copy
        expect(modified.scheme).toBe('file');
        expect(modified.fsPath).toContain(FILE_NAME);
    });

    it('opens multi-diff with jj-edit scheme for mutable ancestor commit', async () => {
        const FILE_NAME = 'file1.txt';
        repo.writeFile(FILE_NAME, 'content 1');
        repo.describe('ancestor commit');
        const ancestorChangeId = repo.getChangeId('@');

        // Create new working copy commit on top
        repo.new();

        await showMultiFileDiffCommand(ctx, { revision: ancestorChangeId });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const multiDiff = ctx.host.nav.multiDiffsOpened[0];
        const modified = multiDiff.resources[0].rightUri;

        // Modified (right) should use jj-edit scheme for ancestor commit
        expect(modified.scheme).toBe('jj-edit');
        expect(modified.fragment).toContain(`revision=${ancestorChangeId}`);
        expect(modified.path).toContain(FILE_NAME);
    });

    it('resolves @ to working copy file URI', async () => {
        repo.writeFile('file.txt', 'content');

        await showMultiFileDiffCommand(ctx, { revision: '@' });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const multiDiff = ctx.host.nav.multiDiffsOpened[0];
        const modified = multiDiff.resources[0].rightUri;
        expect(modified.scheme).toBe('file');
        expect(modified.fsPath).toContain('file.txt');
    });

    it('shows info message when no changes found', async () => {
        await showMultiFileDiffCommand(ctx, { revision: '@' });

        expect(ctx.host.ui.infoMessages[0]).toContain('No changes found in revision');
        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(0);
    });

    it('uses fallback title when commit description is empty', async () => {
        repo.writeFile('file.txt', 'content');
        const changeId = repo.getChangeId('@');
        const shortId = changeId.slice(0, 8);

        await showMultiFileDiffCommand(ctx, { revision: changeId });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        expect(ctx.host.nav.multiDiffsOpened[0].title).toBe(`Changes in ${shortId}`);
    });

    it('does not truncate titles up to 100 characters', async () => {
        repo.writeFile('file.txt', 'content');
        // shortId (8) + ': ' (2) + 90 chars = 100 chars total
        const subject = 'a'.repeat(90);
        repo.describe(`${subject}\n\nExtra body text that should be ignored`);
        const changeId = repo.getChangeId('@');
        const shortId = changeId.slice(0, 8);

        await showMultiFileDiffCommand(ctx, { revision: changeId });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const { title } = ctx.host.nav.multiDiffsOpened[0];
        expect(title).toBe(`${shortId}: ${subject}`);
        expect(title).toHaveLength(100);
    });

    it('truncates multi-diff title to 100 characters when subject line exceeds limit', async () => {
        repo.writeFile('file.txt', 'content');
        const longSubject = 'a very very long subject line '.repeat(7).trim(); // > 188 chars
        repo.describe(longSubject);
        const changeId = repo.getChangeId('@');
        const shortId = changeId.slice(0, 8);

        await showMultiFileDiffCommand(ctx, { revision: changeId });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const { title } = ctx.host.nav.multiDiffsOpened[0];
        const expectedRaw = `${shortId}: ${longSubject}`;
        expect(title).toHaveLength(100);
        expect(title).toBe(`${expectedRaw.slice(0, 97)}...`);
        expect(title.endsWith('...')).toBe(true);
    });

    it('opens jj-view right URIs for mutable non-working-copy commit when editableMutableDiffs is false while keeping @ as file://', async () => {
        repo.writeFile('ancestor.txt', 'ancestor content\n');
        repo.describe('mutable ancestor');
        const ancestorChangeId = repo.getChangeId('@');
        repo.new([], 'working copy');
        repo.writeFile('wc.txt', 'wc content\n');
        const wcChangeId = repo.getChangeId('@');

        await ctx.host.config.update('editableMutableDiffs', false);

        await showMultiFileDiffCommand(ctx, { revision: ancestorChangeId });
        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const ancestorDiff = ctx.host.nav.multiDiffsOpened[0];
        expect(ancestorDiff.resources).toHaveLength(1);
        expect(ancestorDiff.resources[0].leftUri.scheme).toBe('jj-view');
        expect(ancestorDiff.resources[0].rightUri.scheme).toBe('jj-view');
        expect(ancestorDiff.resources[0].rightUri.fragment).toContain('side=right');

        await showMultiFileDiffCommand(ctx, { revision: wcChangeId });
        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(2);
        const wcDiff = ctx.host.nav.multiDiffsOpened[1];
        expect(wcDiff.resources[0].rightUri.scheme).toBe('file');
    });

    it('declares resourceLabelFormatters in package.json to strip leading path separator for custom schemes', async () => {
        const pkgPath = path.resolve(__dirname, '../../../package.json');
        const pkgContent = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as {
            contributes?: {
                resourceLabelFormatters?: Array<{
                    scheme: string;
                    formatting: {
                        label: string;
                        separator: string;
                        stripPathStartingSeparator: boolean;
                    };
                }>;
            };
        };

        const formatters = pkgContent.contributes?.resourceLabelFormatters ?? [];
        const schemes = ['jj-view', 'jj-edit', 'jj-merge-output'];

        for (const scheme of schemes) {
            const formatter = formatters.find((f) => f.scheme === scheme);
            expect(formatter, `Expected resourceLabelFormatter for ${scheme}`).toBeDefined();
            expect(formatter?.formatting.stripPathStartingSeparator).toBe(true);
            expect(formatter?.formatting.label).toBe('$' + '{path}');
            expect(formatter?.formatting.separator).toBe('/');
        }
    });

    it('matches leftUri.path and rightUri.path for working-copy modified files while preserving distinct paths for genuine renames', async () => {
        const renameContent = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10);
        await buildGraph(repo, [
            {
                label: 'base',
                description: 'base commit',
                files: {
                    'cli/src/cli_util.rs': 'fn util() { 1 }\n',
                    'old_name.txt': renameContent,
                },
            },
            {
                label: 'wc',
                parents: ['base'],
                description: 'modify and rename',
                isCurrentWorkingCopy: true,
            },
        ]);
        repo.writeFile('cli/src/cli_util.rs', 'fn util() { 2 }\n');
        repo.moveFile('old_name.txt', 'new_name.txt');

        await showMultiFileDiffCommand(ctx, { revision: '@' });

        expect(ctx.host.nav.multiDiffsOpened).toHaveLength(1);
        const { resources } = ctx.host.nav.multiDiffsOpened[0];
        const modified = resources.find((r) => r.label === 'cli/src/cli_util.rs');
        const renamed = resources.find((r) => r.label === 'new_name.txt');

        expect(modified).toBeDefined();
        expect(modified?.status).toBe('modified');
        expect(modified?.oldLabel).toBeUndefined();
        expect(modified?.leftUri.scheme).toBe('jj-view');
        expect(modified?.rightUri.scheme).toBe('file');
        expect(modified?.leftUri.path).toBe(modified?.rightUri.path);
        expect(modified?.leftUri.fragment).toContain('side=left');

        expect(renamed).toBeDefined();
        expect(renamed?.status).toBe('renamed');
        expect(renamed?.oldLabel).toBe('old_name.txt');
        expect(renamed?.leftUri.scheme).toBe('jj-view');
        expect(renamed?.rightUri.scheme).toBe('file');
        expect(renamed?.leftUri.path).not.toBe(renamed?.rightUri.path);
        expect(renamed?.leftUri.path).toContain('/old_name.txt');
        expect(renamed?.rightUri.path).toContain('/new_name.txt');
    });

    it('matches leftUri.path and rightUri.path for nested subfolder repositories', async () => {
        const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-nested-unit-'));
        const nestedRepo = new TestRepo(path.join(parentDir, 'subrepo'));
        try {
            nestedRepo.init();
            await buildGraph(nestedRepo, [
                {
                    label: 'base',
                    description: 'base',
                    files: { 'cli/src/cli_util.rs': 'v1\n' },
                },
                {
                    label: 'wc',
                    parents: ['base'],
                    description: 'nested modify',
                    files: { 'cli/src/cli_util.rs': 'v2\n' },
                    isCurrentWorkingCopy: true,
                },
            ]);
            const nestedJj = new JjService(nestedRepo.path, NO_OP_LOGGER);
            const nestedCtx = new FakeCommandContext(createMock<JjRepository>({ jj: nestedJj }));

            await showMultiFileDiffCommand(nestedCtx, { revision: '@' });

            expect(nestedCtx.host.nav.multiDiffsOpened).toHaveLength(1);
            const res = nestedCtx.host.nav.multiDiffsOpened[0].resources[0];
            expect(res.leftUri.scheme).toBe('jj-view');
            expect(res.rightUri.scheme).toBe('file');
            expect(res.leftUri.path).toBe(res.rightUri.path);
            expect(res.leftUri.path.endsWith('/subrepo/cli/src/cli_util.rs')).toBe(true);
        } finally {
            await nestedRepo.dispose();
            await fs.rm(parentDir, { recursive: true, force: true });
        }
    });
});
