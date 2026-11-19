/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';
import type { CodeForgeCommentThread } from '../../src/core/code-forge-provider';
import type { CommentsManager } from '../../src/core/comments-manager';
import { EventEmitter } from '../../src/core/host/events';
import { Uri } from '../../src/core/uri-utils';
import { makeQuickOpenItem } from '../src/app/quick-open';
import { resolveScmResourceState } from '../src/app/scm-resource-lookup';
import { CommentsStore, normalizeThreadPath } from '../src/comments/comments-store.svelte';
import { getFileExtension } from '../src/diff/binary-detection';
import { filterAndScoreQuickPickItems, scoreFuzzyPath } from '../src/quick-input/fuzzy-score';
import { formatRepositoryDisplayNames } from '../src/scm/scm-repo-types';
import { createMock } from './test-mock';

describe('Web path helpers with literal backslashes (#435)', () => {
    test('scoreFuzzyPath matches literal backslashes on POSIX and separates paths on win32', () => {
        expect(scoreFuzzyPath('foo\\bar.txt', 'foo\\bar', 'linux')).not.toBeNull();
        expect(scoreFuzzyPath('sub/a\\b.txt', 'sub a\\b', 'linux')).not.toBeNull();
        expect(scoreFuzzyPath('sub/a\\b.txt', 'a\\b', 'linux')).not.toBeNull();
        expect(scoreFuzzyPath('sub/bar.txt', 'sub\\bar', 'win32')).not.toBeNull();
    });

    test('makeQuickOpenItem keeps literal backslash inside label on POSIX', () => {
        const rootItem = makeQuickOpenItem('/repo/foo\\bar.txt', 'foo\\bar.txt', 'Modified', 4000, 'linux');
        expect(rootItem.label).toBe('foo\\bar.txt');
        expect(rootItem.description).toBeUndefined();
        expect(rootItem.filterText).toBe('foo\\bar.txt');

        const nestedItem = makeQuickOpenItem('/repo/sub/a\\b.txt', 'sub/a\\b.txt', undefined, 0, 'linux');
        expect(nestedItem.label).toBe('a\\b.txt');
        expect(nestedItem.description).toBe('sub');
    });

    test('resolveScmResourceState matches working copy and ancestor backslash files without mangling', () => {
        const workspaceRoot = '/repo';
        const state = resolveScmResourceState({
            workspaceRoot,
            rightUri: Uri.from({ scheme: 'file', path: '/repo/foo\\bar.txt' }),
            snapshot: {
                workingCopyChanges: [{ path: 'foo\\bar.txt', status: 'modified' }],
                workingCopyStatuses: new Map(),
                workingCopyLabel: 'Working Copy',
                workingCopyContextValue: 'jjWorkingCopy',
                conflictedPaths: [],
                ancestors: [],
                parentMutable: true,
                hasChild: false,
                description: 'wc',
                workingCopyCount: 1,
                currentEntry: {
                    commit_id: 'abc',
                    change_id: 'xyz',
                    description: 'wc',
                    author: { name: 'a', email: 'a@b', timestamp: '2026-01-01T00:00:00Z' },
                    committer: { name: 'a', email: 'a@b', timestamp: '2026-01-01T00:00:00Z' },
                    parents: [],
                    bookmarks: [],
                },
            },
            platform: 'linux',
        });

        expect(state).toBeDefined();
        expect(state?.relativePath).toBe('foo\\bar.txt');
        expect(state?.leftUri?.path).toBe('/repo/foo\\bar.txt');
    });

    test('normalizeThreadPath and getFileExtension preserve literal backslashes on POSIX', () => {
        expect(normalizeThreadPath('/repo/foo\\bar.txt', '/repo', 'linux')).toBe('foo\\bar.txt');
        expect(normalizeThreadPath('C:\\repo\\sub\\file.ts', 'C:\\repo', 'win32')).toBe('sub/file.ts');
        expect(getFileExtension('foo\\pic.png', 'linux')).toBe('.png');
        expect(getFileExtension('foo.png\\plain', 'linux')).toBe('.png\\plain');
        expect(getFileExtension('foo.png/plain', 'linux')).toBe('');
        expect(getFileExtension('dir.v1\\file', 'win32')).toBe('');
        expect(getFileExtension('dir.v1\\file', 'linux')).toBe('.v1\\file');
        expect(getFileExtension('dir/sub\\image.webp (Working Copy)', 'linux')).toBe('.webp');
    });

    test('CommentsStore.handlesForFile, filterAndScoreQuickPickItems, and formatRepositoryDisplayNames respect host platform', () => {
        const emitter = new EventEmitter<CodeForgeCommentThread[]>();
        const threads: CodeForgeCommentThread[] = [
            {
                id: 't-posix',
                filePath: '/repo/foo\\bar.txt',
                line: 3,
                isResolved: false,
                comments: [],
            },
            {
                id: 't-win',
                filePath: 'C:\\repo\\sub\\bar.txt',
                line: 5,
                isResolved: false,
                comments: [],
            },
        ];

        const makeManager = (currentRepoPath: string) =>
            createMock<CommentsManager>({
                threads,
                currentRepoPath,
                onDidChangeThreads: emitter.event,
            });

        const linuxStore = new CommentsStore(makeManager('/repo'), () => 'linux');
        expect(linuxStore.handlesForFile('foo\\bar.txt').map((h) => h.id)).toEqual(['t-posix']);
        expect(linuxStore.handlesForFile('foo/bar.txt')).toEqual([]);
        linuxStore.dispose();

        const winStore = new CommentsStore(makeManager('C:\\repo'), () => 'win32');
        expect(winStore.handlesForFile('sub\\bar.txt').map((h) => h.id)).toEqual(['t-win']);
        expect(winStore.handlesForFile('sub/bar.txt').map((h) => h.id)).toEqual(['t-win']);
        winStore.dispose();

        const posixQuickPick = filterAndScoreQuickPickItems(
            [
                { id: '1', label: 'foo\\bar.txt', filterText: 'foo\\bar.txt' },
                { id: '2', label: 'other.txt', filterText: 'other.txt' },
            ],
            'foo\\bar',
            { platform: 'linux' },
        );
        expect(posixQuickPick.map((item) => item.label)).toEqual(['foo\\bar.txt']);

        const winQuickPick = filterAndScoreQuickPickItems(
            [{ id: '1', label: 'bar.txt', description: 'sub', filterText: 'sub/bar.txt' }],
            'sub\\bar',
            { platform: 'win32' },
        );
        expect(winQuickPick.map((item) => item.label)).toEqual(['bar.txt']);

        const posixDisplay = formatRepositoryDisplayNames(
            ['/work/a/my\\repo', '/work/b/my\\repo', '/work/c/unique\\name'],
            'linux',
        );
        expect(posixDisplay.get('/work/a/my\\repo')).toEqual({ name: 'my\\repo', qualifier: 'a' });
        expect(posixDisplay.get('/work/b/my\\repo')).toEqual({ name: 'my\\repo', qualifier: 'b' });
        expect(posixDisplay.get('/work/c/unique\\name')).toEqual({ name: 'unique\\name' });

        const winDisplay = formatRepositoryDisplayNames(['C:\\work\\a\\app'], 'win32');
        expect(winDisplay.get('C:\\work\\a\\app')).toEqual({ name: 'app' });
    });
});
