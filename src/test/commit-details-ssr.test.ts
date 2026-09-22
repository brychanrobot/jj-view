/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { CommitDetailsPayload } from '../core/host/ipc/commit-details-schemas';
import CommitDetailsApp from '../core/webview/commit-details/CommitDetailsApp.svelte';

describe('CommitDetailsApp SSR Rendering', () => {
    it('successfully server-renders standard commit details into HTML without errors or effect_orphan', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'krsyowswxmxnqznrtlpuyutskyzrpunp',
            commitId: 'abcdef1234567890abcdef1234567890abcdef12',
            description: 'feat: server rendered commit message\n\nMore details in the body.',
            files: [],
            isLoadingFiles: true,
            isImmutable: false,
            isEmpty: false,
            isConflict: false,
            author: {
                name: 'Test Author',
                email: 'author@example.com',
                timestamp: '2026-09-14T19:00:00Z',
            },
            bookmarks: [{ name: 'main' }],
            tags: ['v1.0.0'],
            minChangeIdLength: 4,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        expect(html).toContain('commit-details-container');
        expect(html).toContain('krsyowswxmxnqznrtlpuyutskyzrpunp');
        expect(html).toContain('feat: server rendered commit message');
        expect(html).toContain('Test Author');
        expect(html).toContain('author@example.com');
        expect(html).toContain('main');
        expect(html).toContain('v1.0.0');
    });

    it('successfully renders empty description and empty commit without errors', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'yownpxzvrstklnmqtvupqwuyxzropklm',
            commitId: '1234567890abcdef1234567890abcdef12345678',
            description: '',
            files: [],
            isLoadingFiles: false,
            isImmutable: false,
            isEmpty: true,
            isConflict: false,
            minChangeIdLength: 4,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        expect(html).toContain('commit-details-container');
        expect(html).toContain('yownpxzvrstklnmqtvupqwuyxzropklm');
    });

    it('renders conflict commit state properly', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'conflictedchange1234567890abcdef',
            commitId: 'conflictcommit1234567890abcdef12',
            description: 'conflict commit',
            files: [],
            isLoadingFiles: false,
            isImmutable: false,
            isEmpty: false,
            isConflict: true,
            minChangeIdLength: 4,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        expect(html).toContain('commit-details-container');
        expect(html).toContain('conflictedchange1234567890abcdef');
        expect(html).toContain('conflict commit');
    });

    it('renders immutable commit without breaking', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'immutablechange1234567890abcdef',
            commitId: 'immutablecommit1234567890abcdef12',
            description: 'root or pushed commit',
            files: [],
            isLoadingFiles: false,
            isImmutable: true,
            isEmpty: false,
            isConflict: false,
            minChangeIdLength: 4,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        expect(html).toContain('commit-details-container');
        expect(html).toContain('immutablechange1234567890abcdef');
    });

    it('safely escapes HTML in commit description during SSR', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'xsschange1234567890abcdef123456',
            commitId: 'xsscommit1234567890abcdef123456',
            description: '<script>alert("xss")</script> & <b>bold</b>',
            files: [],
            isLoadingFiles: false,
            isImmutable: false,
            isEmpty: false,
            isConflict: false,
            minChangeIdLength: 4,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        // Raw unsanitized <script> tag must NOT be present as an executable script tag in rendered HTML
        expect(html).not.toContain('<script>alert("xss")</script>');
        expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('highlights shortest change ID prefix and renders remainder of full change ID', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'krsyowswxmxnqznrtlpuyutskyzrpunp',
            changeIdShortest: 'krsy',
            commitId: 'abcdef1234567890abcdef1234567890abcdef12',
            description: 'feat: test shortest highlighting',
            files: [],
            isLoadingFiles: false,
            isImmutable: false,
            isEmpty: false,
            isConflict: false,
            minChangeIdLength: 8,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        expect(html).toContain('change-id-prefix');
        expect(html).toContain('krsy');
        expect(html).toContain('change-id-rest');
        expect(html).toContain('owswxmxnqznrtlpuyutskyzrpunp');
    });

    it('renders divergent change ID offset properly in commit details', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'krsyowswxmxnqznrtlpuyutskyzrpunp/2',
            changeIdShortest: 'krsy',
            isDivergent: true,
            changeIdOffset: 2,
            commitId: 'abcdef1234567890abcdef1234567890abcdef12',
            description: 'feat: test divergent offset',
            files: [],
            isLoadingFiles: false,
            isImmutable: false,
            isEmpty: false,
            isConflict: false,
            minChangeIdLength: 4,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        expect(html).toContain('change-id-prefix');
        expect(html).toContain('krsy');
        expect(html).toContain('change-id-offset');
        expect(html).toContain('/2');
    });

    it('renders file paths with directory and filename without intervening spaces (#595)', () => {
        const initialCommit: CommitDetailsPayload = {
            changeId: 'krsyowswxmxnqznrtlpuyutskyzrpunp',
            commitId: 'abcdef1234567890abcdef1234567890abcdef12',
            description: 'test: file paths',
            files: [
                {
                    path: 'src/core/webview/CommitDetails.svelte',
                    status: 'modified',
                },
                {
                    path: 'root-file.txt',
                    status: 'added',
                },
            ],
            isLoadingFiles: false,
            isImmutable: false,
            isEmpty: false,
            isConflict: false,
            minChangeIdLength: 4,
        };

        const result = render(CommitDetailsApp, { props: { initialCommit } });
        const html = result.body;

        expect(html).toContain('file-path-container');
        expect(html).toContain('src/core/webview/');
        expect(html).toContain('CommitDetails.svelte</span>');
        expect(html).toMatch(
            /<span class="file-dir[^"]*">src\/core\/webview\/<\/span>(?:<!--.*?-->)*<span class="file-name/,
        );
        expect(html).not.toContain('src/core/webview/</span> ');
    });
});
