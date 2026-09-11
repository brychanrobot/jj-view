/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { CommitDragData } from '../core/webview/log/components/CommitDragPreview';
import CommitDragPreview from '../core/webview/log/components/CommitDragPreview.svelte';
import { SQUASH_INTO_MODIFIER } from '../core/webview/log/utils/drag-modifiers';

describe('CommitDragPreview Component', () => {
    it('renders change ID with bold prefix and remainder string', () => {
        const commit: CommitDragData = {
            changeId: 'kkmpptxz',
            change_id_shortest: 'kk',
            description: 'feat: new feature',
        };

        const result = render(CommitDragPreview, { props: { commit, minChangeIdLength: 4 } });
        const html = result.body;

        expect(html).toContain('feat: new feature');
        expect(html).toContain('kk');
        expect(html).toContain('mp');
        expect(html).toContain('Rebase Branch');
    });

    it('renders fallback description when description is empty', () => {
        const commit: CommitDragData = {
            changeId: 'yvznlqor',
            change_id_shortest: 'y',
        };

        const result = render(CommitDragPreview, { props: { commit, minChangeIdLength: 1 } });
        const html = result.body;

        expect(html).toContain('(no description)');
        expect(html).toContain('y');
    });

    it('renders active modifier badge and label when modifier is passed', () => {
        const commit: CommitDragData = {
            changeId: 'yvznlqor',
            change_id_shortest: 'y',
            description: 'squash me',
        };

        const result = render(CommitDragPreview, {
            props: { commit, activeModifier: SQUASH_INTO_MODIFIER, minChangeIdLength: 3 },
        });
        const html = result.body;

        expect(html).toContain('Squash Into');
        expect(html).toContain('Squash source commit into target');
        expect(html).toContain('S');
    });
});
