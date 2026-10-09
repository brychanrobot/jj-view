/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { CommitDragData } from '../core/webview/log/components/CommitDragPreview';
import CommitDragPreview from '../core/webview/log/components/CommitDragPreview.svelte';
import { INSERT_AFTER_BRANCH_MODIFIER, SQUASH_INTO_MODIFIER } from '../core/webview/log/utils/drag-modifiers';

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

    it('renders +n children indicator when modifier includes descendants and descendantCount > 0', () => {
        const commit: CommitDragData = {
            changeId: 'yvznlqor',
            change_id_shortest: 'y',
            description: 'branch base',
            descendantCount: 3,
        };

        const result = render(CommitDragPreview, {
            props: { commit, minChangeIdLength: 3 },
        });
        const html = result.body;

        expect(html).toContain('+3 children');
    });

    it('renders +1 child indicator singular when descendantCount is 1', () => {
        const commit: CommitDragData = {
            changeId: 'yvznlqor',
            change_id_shortest: 'y',
            description: 'branch base',
            descendantCount: 1,
        };

        const result = render(CommitDragPreview, {
            props: { commit, minChangeIdLength: 3 },
        });
        const html = result.body;

        expect(html).toContain('+1 child');
    });

    it('does not render children indicator when descendantCount is 0 or modifier excludes descendants', () => {
        const commitWithZero: CommitDragData = {
            changeId: 'yvznlqor',
            descendantCount: 0,
        };
        const zeroResult = render(CommitDragPreview, {
            props: { commit: commitWithZero, minChangeIdLength: 3 },
        });
        expect(zeroResult.body).not.toContain('child');

        const commitWithDescendants: CommitDragData = {
            changeId: 'yvznlqor',
            descendantCount: 2,
        };
        // SQUASH_INTO_MODIFIER does not include descendants
        const squashResult = render(CommitDragPreview, {
            props: { commit: commitWithDescendants, activeModifier: SQUASH_INTO_MODIFIER, minChangeIdLength: 3 },
        });
        expect(squashResult.body).not.toContain('children');
    });

    it('always renders shift variants (Shift + A, Shift + B, Shift + S) in the command badge matrix', () => {
        const commit: CommitDragData = {
            changeId: 'yvznlqor',
            change_id_shortest: 'y',
        };
        const result = render(CommitDragPreview, {
            props: { commit, minChangeIdLength: 1 },
        });
        const html = result.body;

        expect(html).toContain('Shift + A');
        expect(html).toContain('Insert Branch After');
        expect(html).toContain('Shift + B');
        expect(html).toContain('Insert Branch Before');
        expect(html).toContain('Shift + S');
        expect(html).toContain('Squash Onto');
    });

    it('highlights active modifier in the command badge matrix', () => {
        const commit: CommitDragData = {
            changeId: 'yvznlqor',
            change_id_shortest: 'y',
        };
        const result = render(CommitDragPreview, {
            props: { commit, activeModifier: INSERT_AFTER_BRANCH_MODIFIER, minChangeIdLength: 1 },
        });
        const html = result.body;

        // Shift + A receives current class
        expect(html).toMatch(/class="[^"]*badge-container[^"]*current[^"]*"[^>]*>[^<]*<kbd[^>]*>[^<]*Shift \+ A/);
    });
});
