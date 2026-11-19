/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JjDecorationModel } from '../core/jj-decoration-model';
import type { JjService } from '../core/jj-service';
import type { JjStatusEntry } from '../core/jj-types';
import { createDiffUris, Uri } from '../core/uri-utils';
import { createMock } from './test-utils';

describe('JjDecorationModel Unit Tests', () => {
    let mockJj: JjService;
    let model: JjDecorationModel;

    beforeEach(() => {
        mockJj = createMock<JjService>({
            checkTrackedPaths: vi.fn().mockResolvedValue(['tracked.txt', 'dir/sub.txt']),
        });
        model = new JjDecorationModel(mockJj, '/workspace');
    });

    it('returns Conflicted decoration when status is conflicted', () => {
        const scmMap = new Map<string, JjStatusEntry>();
        scmMap.set('/conflict.txt', {
            path: 'conflict.txt',
            status: 'modified',
            conflicted: true,
        });

        model.updateScmAndTrackedStatus(scmMap);

        const dec = model.getDecoration(Uri.file('/workspace/conflict.txt'));
        expect(dec).toEqual({
            badge: '!',
            tooltip: 'Conflicted',
            colorKey: 'jj.conflicted',
        });
    });

    it('returns Modified decoration for modified files', () => {
        const scmMap = new Map<string, JjStatusEntry>();
        scmMap.set('/modified.txt', {
            path: 'modified.txt',
            status: 'modified',
            conflicted: false,
        });

        model.updateScmAndTrackedStatus(scmMap);

        const dec = model.getDecoration(Uri.file('/workspace/modified.txt'));
        expect(dec).toEqual({
            badge: 'M',
            tooltip: 'Modified',
            colorKey: 'gitDecoration.modifiedResourceForeground',
        });
    });

    it('returns Ignored decoration immediately for .jj paths', () => {
        const dec = model.getDecoration(Uri.file('/workspace/.jj/repo'));
        expect(dec).toEqual({
            tooltip: 'Ignored',
            colorKey: 'gitDecoration.ignoredResourceForeground',
        });
    });

    it('emits onDidChangeDecorations when SCM status changes', () => {
        const listener = vi.fn();
        model.onDidChangeDecorations(listener);

        const scmMap = new Map<string, JjStatusEntry>();
        scmMap.set('/file.txt', {
            path: 'file.txt',
            status: 'added',
            conflicted: false,
        });

        model.updateScmAndTrackedStatus(scmMap);
        expect(listener).toHaveBeenCalled();
    });

    it('clears ignored file cache and notifies listeners', () => {
        const listener = vi.fn();
        model.onDidChangeDecorations(listener);

        model.clearIgnoredFileDecorationsCache();
        expect(listener).toHaveBeenCalledWith(undefined);
    });

    it('resolves decorations for jj-view and jj-edit URIs with full workspace paths', () => {
        const entry: JjStatusEntry = {
            path: 'src/modified.txt',
            status: 'modified',
            conflicted: false,
        };
        const scmMap = new Map<string, JjStatusEntry>();
        scmMap.set('/src/modified.txt', entry);
        model.updateScmAndTrackedStatus(scmMap);

        const { leftUri, rightUri } = createDiffUris(entry, 'anc123', '/workspace', { editable: true });
        expect(model.getDecoration(leftUri)).toEqual({
            badge: 'M',
            tooltip: 'Modified',
            colorKey: 'gitDecoration.modifiedResourceForeground',
        });
        expect(model.getDecoration(rightUri)).toEqual({
            badge: 'M',
            tooltip: 'Modified',
            colorKey: 'gitDecoration.modifiedResourceForeground',
        });
    });

    it('returns undefined for jj-view and jj-edit URIs belonging to another repository', () => {
        const entry: JjStatusEntry = {
            path: 'src/modified.txt',
            status: 'modified',
            conflicted: false,
        };
        const scmMap = new Map<string, JjStatusEntry>();
        scmMap.set('/subrepo/src/modified.txt', entry);
        scmMap.set('/src/modified.txt', entry);
        model.updateScmAndTrackedStatus(scmMap);

        const nestedRepoUris = createDiffUris(entry, 'anc123', '/workspace/subrepo', { editable: true });
        expect(model.getDecoration(nestedRepoUris.leftUri)).toBeUndefined();
        expect(model.getDecoration(nestedRepoUris.rightUri)).toBeUndefined();

        const siblingRepoUris = createDiffUris(entry, 'anc123', '/other-workspace', { editable: true });
        expect(model.getDecoration(siblingRepoUris.leftUri)).toBeUndefined();
        expect(model.getDecoration(siblingRepoUris.rightUri)).toBeUndefined();
    });
});
