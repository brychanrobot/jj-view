/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openChangesCommand, openFileCommand } from '../../core/commands/open';
import type { JjRepository } from '../../core/jj-repository';
import type { JjResourceState } from '../../core/scm-resource-state';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { createMock } from '../test-utils';

describe('openFileCommand', () => {
    let ctx: FakeCommandContext;

    beforeEach(() => {
        ctx = new FakeCommandContext(createMock<JjRepository>({}));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no args and no resourceUri', async () => {
        await openFileCommand(ctx, {});
        expect(ctx.host.nav.filesOpened).toHaveLength(0);
    });

    test('executes openFile from resourceUri with revision query', async () => {
        await openFileCommand(ctx, {
            resourceUri: Uri.parse('file:///foo?jj-revision=@'),
        });

        expect(ctx.host.nav.filesOpened).toEqual([
            expect.objectContaining({
                scheme: 'file',
                path: '/foo',
                query: '',
            }),
        ]);
    });

    test('executes openFile from a historical URI (jj-view scheme)', async () => {
        const uri = Uri.parse('jj-view:///foo/bar.txt?base=c123&side=left');

        await openFileCommand(ctx, { resourceUri: uri });

        expect(ctx.host.nav.filesOpened).toEqual([
            expect.objectContaining({
                scheme: 'file',
                path: '/foo/bar.txt',
                query: '',
            }),
        ]);
    });

    test('executes openFile from jj-edit scheme URI', async () => {
        await openFileCommand(ctx, {
            resourceUri: Uri.parse('jj-edit:///baz/qux.ts?revision=rev123'),
        });

        expect(ctx.host.nav.filesOpened).toEqual([
            expect.objectContaining({
                scheme: 'file',
                path: '/baz/qux.ts',
                query: '',
            }),
        ]);
    });
});

describe('openChangesCommand', () => {
    let ctx: FakeCommandContext;

    beforeEach(() => {
        ctx = new FakeCommandContext(createMock<JjRepository>({}));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('does nothing if no resource state', async () => {
        await openChangesCommand(ctx, {});
        expect(ctx.host.nav.diffsOpened).toHaveLength(0);
    });

    test('does nothing if resource state has no leftUri or rightUri', async () => {
        const resourceState = createMock<JjResourceState>({
            resourceUri: Uri.file('/foo'),
            revision: '@',
        });

        await openChangesCommand(ctx, { resourceState });
        expect(ctx.host.nav.diffsOpened).toHaveLength(0);
    });

    test('executes the diffCommand with its URIs and title', async () => {
        const leftUri = Uri.file('/left');
        const rightUri = Uri.file('/right');
        const resourceState = createMock<JjResourceState>({
            resourceUri: Uri.file('/foo'),
            revision: '@',
            leftUri,
            rightUri,
            diffTitle: 'foo.txt (Working Copy)',
        });

        await openChangesCommand(ctx, { resourceState });

        expect(ctx.host.nav.diffsOpened).toEqual([
            {
                leftUri,
                rightUri,
                title: 'foo.txt (Working Copy)',
            },
        ]);
    });
});
