/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JjMergeService } from '../core/jj-merge-service';
import type { JjService } from '../core/jj-service';
import { Uri } from '../core/uri-utils';
import { createMock } from './test-utils';

describe('JjMergeService Unit Tests', () => {
    let mockJj: JjService;
    let service: JjMergeService;

    beforeEach(() => {
        mockJj = createMock<JjService>({
            getConflictParts: vi.fn().mockResolvedValue({
                base: 'base content',
                left: 'ours content',
                right: 'theirs content',
            }),
        });
        service = new JjMergeService(mockJj);
    });

    it('returns conflict part for base, left, and right', async () => {
        const baseUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=base');
        const leftUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=left');
        const rightUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=right');

        expect(await service.provideContent(baseUri)).toBe('base content');
        expect(await service.provideContent(leftUri)).toBe('ours content');
        expect(await service.provideContent(rightUri)).toBe('theirs content');
    });

    it('caches conflict parts for subsequent queries on same path', async () => {
        const leftUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=left');
        const rightUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=right');

        await service.provideContent(leftUri);
        await service.provideContent(rightUri);

        expect(mockJj.getConflictParts).toHaveBeenCalledTimes(1);
    });

    it('clears cache and re-fetches', async () => {
        const leftUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=left');

        await service.provideContent(leftUri);
        service.clearCache('/workspace/conflict.txt');
        await service.provideContent(leftUri);

        expect(mockJj.getConflictParts).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent in-flight requests for the same path', async () => {
        let resolveConflict!: (val: { base: string; left: string; right: string }) => void;
        const deferred = new Promise<{ base: string; left: string; right: string }>((res) => {
            resolveConflict = res;
        });
        mockJj = createMock<JjService>({
            getConflictParts: vi.fn().mockReturnValue(deferred),
        });
        service = new JjMergeService(mockJj);

        const baseUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=base');
        const leftUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=left');
        const rightUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=right');

        const [p1, p2, p3] = [
            service.provideContent(baseUri),
            service.provideContent(leftUri),
            service.provideContent(rightUri),
        ];

        resolveConflict({ base: 'base content', left: 'ours content', right: 'theirs content' });

        expect(await p1).toBe('base content');
        expect(await p2).toBe('ours content');
        expect(await p3).toBe('theirs content');
        expect(mockJj.getConflictParts).toHaveBeenCalledTimes(1);
    });

    it('does not populate cache with stale result if clearCache was called while request was in-flight', async () => {
        let resolveFirst!: (val: { base: string; left: string; right: string }) => void;
        const firstDeferred = new Promise<{ base: string; left: string; right: string }>((res) => {
            resolveFirst = res;
        });
        const getConflictPartsMock = vi.fn().mockReturnValueOnce(firstDeferred).mockResolvedValueOnce({
            base: 'new base',
            left: 'new left',
            right: 'new right',
        });
        mockJj = createMock<JjService>({
            getConflictParts: getConflictPartsMock,
        });
        service = new JjMergeService(mockJj);

        const leftUri = Uri.parse('jj-merge:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=left');

        // Start first request
        const firstPromise = service.provideContent(leftUri);

        // Clear cache while first request is in-flight
        service.clearCache('/workspace/conflict.txt');

        // Start second request (which should start a new fetch)
        const secondPromise = service.provideContent(leftUri);

        // Now resolve the first request with stale content
        resolveFirst({ base: 'stale base', left: 'stale left', right: 'stale right' });

        expect(await firstPromise).toBe('stale left');
        expect(await secondPromise).toBe('new left');
        expect(getConflictPartsMock).toHaveBeenCalledTimes(2);

        // Third request should use the cached result from second request, not stale
        const thirdResult = await service.provideContent(leftUri);
        expect(thirdResult).toBe('new left');
        expect(getConflictPartsMock).toHaveBeenCalledTimes(2);
    });

    it('throws error when getConflictParts fails rather than returning error string', async () => {
        mockJj = createMock<JjService>({
            getConflictParts: vi.fn().mockRejectedValue(new Error('Process failed: conflict-capture exited with 1')),
        });
        service = new JjMergeService(mockJj);
        const baseUri = Uri.parse('jj-merge-output:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=base');

        await expect(service.provideContent(baseUri)).rejects.toThrow('Process failed: conflict-capture exited with 1');
    });

    it('returns empty string when URI is missing path or part', async () => {
        const invalidUri = Uri.parse('jj-merge-output:///conflict.txt?path=%2Fworkspace%2Fconflict.txt');
        expect(await service.provideContent(invalidUri)).toBe('');
    });

    it('clears cached content and fires onDidChange when update is called', async () => {
        const leftUri = Uri.parse('jj-merge-output:///conflict.txt?path=%2Fworkspace%2Fconflict.txt&part=left');
        let firedUri: Uri | undefined;
        service.onDidChange((uri) => {
            firedUri = uri;
        });

        await service.provideContent(leftUri);
        service.update(leftUri);

        expect(firedUri?.toString()).toBe(leftUri.toString());
        await service.provideContent(leftUri);
        expect(mockJj.getConflictParts).toHaveBeenCalledTimes(2);
    });
});
