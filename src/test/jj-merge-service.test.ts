/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JjMergeService } from '../jj-merge-service';
import type { JjService } from '../jj-service';
import { Uri } from '../uri-utils';
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
});
