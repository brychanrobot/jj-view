/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    extractBookmarkName,
    promptForRevision,
    RevisionQuery,
    resolveRevisionsWithSelection,
    withDelayedProgress,
} from '../commands/command-utils';
import { JjService, NO_OP_LOGGER } from '../jj-service';
import { buildGraph, TestRepo } from './test-repo';
import { resetMockQuickPick, setActiveItems, setSelectedItems } from './vitest-utils';

// Mock vscode
vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

describe('withDelayedProgress', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should return the result of the promise', async () => {
        const result = await withDelayedProgress('Title', Promise.resolve('success'));
        expect(result).toBe('success');
    });

    it('should propagate errors', async () => {
        const error = new Error('fail');
        await expect(withDelayedProgress('Title', Promise.reject(error))).rejects.toThrow('fail');
    });

    it('should NOT show progress if task is fast (<100ms)', async () => {
        const fastTask = Promise.resolve('done');

        const promise = withDelayedProgress('Fast Task', fastTask);

        // Fast forward less than delay
        vi.advanceTimersByTime(50);

        await promise;

        expect(vscode.window.withProgress).not.toHaveBeenCalled();
    });

    it('should show progress if task is slow (>100ms)', async () => {
        let resolveTask!: (value: string) => void;
        const slowTask = new Promise<string>((resolve) => {
            resolveTask = resolve;
        });

        const promise = withDelayedProgress('Slow Task', slowTask);

        // Advance past the delay
        vi.advanceTimersByTime(150);

        expect(vscode.window.withProgress).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Slow Task' }),
            expect.any(Function),
        );

        resolveTask('finally done');
        await promise;
    });
});

describe('promptForRevision', () => {
    let jj: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        vi.clearAllMocks();
    });

    afterEach(() => {});

    it('returns selected revision from quick pick', async () => {
        const ids = await buildGraph(repo, [
            { label: 'v1', files: { 'file1.txt': 'v1\n' } },
            { label: 'v2', parents: ['v1'], files: { 'file1.txt': 'v2\n' } },
            { label: 'v3', parents: ['v1'], files: { 'file2.txt': 'v3\n' } },
            { label: 'v4', parents: ['v2', 'v3'], files: { 'file1.txt': 'v4\n' } },
        ]);
        const changeId = ids.v4.changeId;

        const mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);

        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
        setSelectedItems(mockQuickPick, [{ label: 'any', detail: changeId }]);
        setActiveItems(mockQuickPick, [{ label: 'any', detail: changeId }]);

        const result = await promptForRevision(jj, { revisionQuery: RevisionQuery.ancestorsExcluding('@') });

        expect(result).toBe(changeId);
    });

    it('returns arbitrary typed text if not in list', async () => {
        await buildGraph(repo, [{ label: 'v1', files: { 'file1.txt': 'v1\n' } }]);

        const mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);

        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
        mockQuickPick.value = 'custom-revision';

        const result = await promptForRevision(jj, { revisionQuery: RevisionQuery.ancestorsExcluding('@') });

        expect(result).toBe('custom-revision');
    });

    it('falls back to input box if no ancestors are found', async () => {
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('manual-rev');

        const result = await promptForRevision(jj, { revisionQuery: RevisionQuery.ancestorsExcluding('root()') });

        expect(result).toBe('manual-rev');
        expect(vscode.window.showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'Enter revision (no ancestors found)' }),
        );
    });

    it('falls back to input box if jj fails', async () => {
        // Break the repo by deleting the .jj directory
        await fs.rm(path.join(repo.path, '.jj'), { recursive: true, force: true });

        vi.mocked(vscode.window.showInputBox).mockResolvedValue('fallback-rev');

        const result = await promptForRevision(jj, { revisionQuery: RevisionQuery.ancestorsExcluding('@') });

        expect(result).toBe('fallback-rev');
        expect(vscode.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Enter revision' }));
    });

    it('configures quick pick to match on description and detail', async () => {
        await buildGraph(repo, [{ label: 'v1', files: { 'file1.txt': 'v1\n' } }]);

        const mockQuickPick = vi.mocked(vscode.window.createQuickPick)();
        resetMockQuickPick(mockQuickPick);

        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });

        await promptForRevision(jj, { revisionQuery: RevisionQuery.ancestorsExcluding('@') });

        expect(mockQuickPick.matchOnDescription).toBe(true);
        expect(mockQuickPick.matchOnDetail).toBe(true);
    });

    it('includes target revision with ancestorsIncluding, and excludes it with ancestorsExcluding', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file1.txt': 'v1\n' } }]);
        const targetChangeId = ids.v1.changeId;

        const mockQuickPick = vi.mocked(vscode.window.createQuickPick)();

        // 1. By default/excluding, target is excluded
        resetMockQuickPick(mockQuickPick);
        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
        mockQuickPick.value = 'fallback';
        await promptForRevision(jj, {
            placeHolder: 'Select',
            emptyPrompt: 'Enter',
            revisionQuery: RevisionQuery.ancestorsExcluding('@'),
        });
        expect(mockQuickPick.items.some((item) => item.detail === targetChangeId)).toBe(false);

        // 2. With ancestorsIncluding, target is included
        resetMockQuickPick(mockQuickPick);
        mockQuickPick.value = 'fallback';
        await promptForRevision(jj, {
            placeHolder: 'Select',
            emptyPrompt: 'Enter',
            revisionQuery: RevisionQuery.ancestorsIncluding('@'),
        });
        expect(mockQuickPick.items.some((item) => item.detail === targetChangeId)).toBe(true);
    });

    it('supports RevisionQuery factory methods (mutable, visible, and custom)', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', files: { 'file1.txt': 'parent\n' } },
            { label: 'child', parents: ['parent'], files: { 'file1.txt': 'child\n' } },
        ]);
        const targetChangeId = ids.child.changeId;

        const mockQuickPick = vi.mocked(vscode.window.createQuickPick)();

        // 1. query: mutable
        resetMockQuickPick(mockQuickPick);
        let acceptCallback: () => void = () => {};
        vi.mocked(mockQuickPick.onDidAccept).mockImplementation((cb) => {
            acceptCallback = cb;
            return { dispose: () => {} };
        });
        vi.mocked(mockQuickPick.show).mockImplementation(() => {
            acceptCallback();
        });
        mockQuickPick.value = 'fallback';
        await promptForRevision(jj, { revisionQuery: RevisionQuery.mutable() });
        expect(mockQuickPick.items.some((item) => item.detail === targetChangeId)).toBe(true);

        // 2. query: visible
        resetMockQuickPick(mockQuickPick);
        await promptForRevision(jj, { revisionQuery: RevisionQuery.visible() });
        expect(mockQuickPick.items.some((item) => item.detail === targetChangeId)).toBe(true);

        // 3. query: custom string
        resetMockQuickPick(mockQuickPick);
        await promptForRevision(jj, { revisionQuery: 'visible()' });
        expect(mockQuickPick.items.some((item) => item.detail === targetChangeId)).toBe(true);

        // 4. query: children
        resetMockQuickPick(mockQuickPick);
        await promptForRevision(jj, { revisionQuery: RevisionQuery.children(ids.parent.changeId) });
        expect(mockQuickPick.items.some((item) => item.detail === targetChangeId)).toBe(true);
    });
});

describe('extractBookmarkName', () => {
    it('extracts bookmark name from string argument', () => {
        expect(extractBookmarkName(['  my-bookmark  '])).toBe('my-bookmark');
        expect(extractBookmarkName(['   '])).toBeUndefined();
    });

    it('extracts bookmark name from object with name or bookmarkName property', () => {
        expect(extractBookmarkName([{ name: '  my-bookmark  ' }])).toBe('my-bookmark');
        expect(extractBookmarkName([{ bookmarkName: '  my-bookmark  ' }])).toBe('my-bookmark');
        expect(extractBookmarkName([{ webviewSection: 'jj.bookmark', bookmarkName: 'my-bookmark' }])).toBe(
            'my-bookmark',
        );
        expect(extractBookmarkName([{ name: '   ' }])).toBeUndefined();
        expect(extractBookmarkName([{}])).toBeUndefined();
    });
});

describe('resolveRevisionsWithSelection', () => {
    it('returns selected IDs when clicked target is included in selection', () => {
        const scmProvider = {
            getSelectedCommitIds: () => ['rev1', 'rev2', 'rev3'],
        };
        const result = resolveRevisionsWithSelection(['rev2'], scmProvider);
        expect(result).toEqual(['rev1', 'rev2', 'rev3']);
    });

    it('returns only explicit arg revisions when clicked target is not in selection', () => {
        const scmProvider = {
            getSelectedCommitIds: () => ['rev1', 'rev2'],
        };
        const result = resolveRevisionsWithSelection(['otherRev'], scmProvider);
        expect(result).toEqual(['otherRev']);
    });

    it('returns selected IDs when no explicit revision args are provided', () => {
        const scmProvider = {
            getSelectedCommitIds: () => ['rev1', 'rev2'],
        };
        const result = resolveRevisionsWithSelection([], scmProvider);
        expect(result).toEqual(['rev1', 'rev2']);
    });

    it('falls back to default revision when no args or selection exist', () => {
        expect(resolveRevisionsWithSelection([])).toEqual(['@']);
        expect(resolveRevisionsWithSelection([], undefined, 'root()')).toEqual(['root()']);
    });
});
