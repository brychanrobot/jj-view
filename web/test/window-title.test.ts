/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { formatWindowTitle } from '../src/app/window-title';

describe('formatWindowTitle', () => {
    it('returns app name alone when no repo or tab is provided', () => {
        expect(formatWindowTitle({})).toBe('JJ View');
        expect(formatWindowTitle({ focusedRepoRoot: '' })).toBe('JJ View');
        expect(formatWindowTitle({ focusedRepoRoot: '.' })).toBe('JJ View');
        expect(formatWindowTitle({ focusedRepoRoot: '..' })).toBe('JJ View');
        expect(formatWindowTitle({ focusedRepoRoot: '/' })).toBe('JJ View');
        expect(formatWindowTitle({ focusedRepoRoot: 'C:\\', platform: 'win32' })).toBe('JJ View');
        expect(
            formatWindowTitle({
                focusedRepoRoot: '/',
                repositoryRoots: ['/', '/work/app'],
            }),
        ).toBe('JJ View');
    });

    it('includes the repository basename for a single repository', () => {
        expect(formatWindowTitle({ focusedRepoRoot: '/home/user/code/jj-view' })).toBe('jj-view \u2014 JJ View');
        expect(formatWindowTitle({ focusedRepoRoot: '/home/user/code/jj-view/' })).toBe('jj-view \u2014 JJ View');
        expect(
            formatWindowTitle({
                focusedRepoRoot: 'C:\\Users\\dev\\my-repo',
                platform: 'win32',
            }),
        ).toBe('my-repo \u2014 JJ View');
    });

    it('disambiguates duplicate repository basenames when multiple repos are open', () => {
        const roots = ['/work/frontend/app', '/work/backend/app'];
        expect(
            formatWindowTitle({
                focusedRepoRoot: '/work/backend/app',
                repositoryRoots: roots,
            }),
        ).toBe('backend/app \u2014 JJ View');
        expect(
            formatWindowTitle({
                focusedRepoRoot: '/work/frontend/app/',
                repositoryRoots: roots,
            }),
        ).toBe('frontend/app \u2014 JJ View');
        expect(
            formatWindowTitle({
                focusedRepoRoot: '//server/share/frontend/app',
                repositoryRoots: ['//server/share/frontend/app', '//server/share/backend/app'],
            }),
        ).toBe('frontend/app \u2014 JJ View');
    });

    it('prepends the active tab title and dirty indicator', () => {
        expect(
            formatWindowTitle({
                activeTabTitle: 'main.ts (abc12345)',
                focusedRepoRoot: '/home/user/code/jj-view',
            }),
        ).toBe('main.ts (abc12345) \u2014 jj-view \u2014 JJ View');

        expect(
            formatWindowTitle({
                activeTabTitle: 'main.ts (abc12345)',
                activeTabDirty: true,
                focusedRepoRoot: '/home/user/code/jj-view',
            }),
        ).toBe('\u25cf main.ts (abc12345) \u2014 jj-view \u2014 JJ View');
    });
});
