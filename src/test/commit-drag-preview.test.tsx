/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type CommitDragData, CommitDragPreview } from '../webview/log/components/CommitDragPreview';
import { SQUASH_INTO_MODIFIER } from '../webview/log/utils/drag-modifiers';

describe('CommitDragPreview Component', () => {
    it('renders change ID with bold prefix and remainder string', () => {
        const commit: CommitDragData = {
            changeId: 'kkmpptxz',
            change_id_shortest: 'kk',
            description: 'feat: new feature',
        };

        const html = renderToStaticMarkup(<CommitDragPreview commit={commit} minChangeIdLength={4} />);

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

        const html = renderToStaticMarkup(<CommitDragPreview commit={commit} minChangeIdLength={1} />);

        expect(html).toContain('(no description)');
        expect(html).toContain('y');
    });

    it('renders active modifier badge and label when modifier is passed', () => {
        const commit: CommitDragData = {
            changeId: 'yvznlqor',
            change_id_shortest: 'y',
            description: 'squash me',
        };

        const html = renderToStaticMarkup(
            <CommitDragPreview commit={commit} activeModifier={SQUASH_INTO_MODIFIER} minChangeIdLength={3} />,
        );

        expect(html).toContain('Squash Into');
        expect(html).toContain('Squash source commit into target');
        expect(html).toContain('S');
    });
});
