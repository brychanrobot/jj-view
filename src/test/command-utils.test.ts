/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { promptForRevision, withDelayedProgress } from '../commands/command-utils';
import { JjService } from '../jj-service';
import { buildGraph, TestRepo } from './test-repo';
import { createMock } from './test-utils';

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
        jj = new JjService(repo.path);
        vi.clearAllMocks();
    });

    afterEach(() => {
        repo.dispose();
    });

    it('returns selected revision from quick pick', async () => {
        const ids = await buildGraph(repo, [
            { label: 'v1', files: { 'file1.txt': 'v1\n' } },
            { label: 'v2', parents: ['v1'], files: { 'file1.txt': 'v2\n' } },
            { label: 'v3', parents: ['v1'], files: { 'file2.txt': 'v3\n' } },
            { label: 'v4', parents: ['v2', 'v3'], files: { 'file1.txt': 'v4\n' } },
        ]);
        const changeId = ids.v4.changeId;

        let acceptCallback: () => void = () => {};
        const mockQuickPick = {
            items: [],
            selectedItems: [{ label: 'any', detail: changeId }],
            activeItems: [{ label: 'any', detail: changeId }],
            onDidChangeValue: vi.fn(),
            onDidAccept: vi.fn().mockImplementation((cb) => {
                acceptCallback = cb;
            }),
            onDidHide: vi.fn(),
            show: vi.fn().mockImplementation(() => {
                acceptCallback();
            }),
            dispose: vi.fn(),
        };
        vi.mocked(vscode.window.createQuickPick).mockReturnValue(
            createMock<vscode.QuickPick<vscode.QuickPickItem>>(mockQuickPick),
        );

        const result = await promptForRevision(jj, '@');

        expect(result).toBe(changeId);
    });

    it('returns arbitrary typed text if not in list', async () => {
        await buildGraph(repo, [{ label: 'v1', files: { 'file1.txt': 'v1\n' } }]);

        let acceptCallback: () => void = () => {};
        const mockQuickPick = {
            items: [],
            selectedItems: [],
            activeItems: [],
            onDidChangeValue: vi.fn(),
            value: 'custom-revision',
            onDidAccept: vi.fn().mockImplementation((cb) => {
                acceptCallback = cb;
            }),
            onDidHide: vi.fn(),
            show: vi.fn().mockImplementation(() => {
                acceptCallback();
            }),
            dispose: vi.fn(),
        };
        vi.mocked(vscode.window.createQuickPick).mockReturnValue(
            createMock<vscode.QuickPick<vscode.QuickPickItem>>(mockQuickPick),
        );

        const result = await promptForRevision(jj, '@');

        expect(result).toBe('custom-revision');
    });

    it('falls back to input box if no ancestors are found', async () => {
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('manual-rev');

        const result = await promptForRevision(jj, 'root()');

        expect(result).toBe('manual-rev');
        expect(vscode.window.showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'Enter revision (no ancestors found)' }),
        );
    });

    it('falls back to input box if jj fails', async () => {
        // Break the repo by deleting the .jj directory
        await fs.rm(path.join(repo.path, '.jj'), { recursive: true, force: true });

        vi.mocked(vscode.window.showInputBox).mockResolvedValue('fallback-rev');

        const result = await promptForRevision(jj, '@');

        expect(result).toBe('fallback-rev');
        expect(vscode.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Enter revision' }));
    });
});
