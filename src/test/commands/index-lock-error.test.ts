/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, afterEach, vi, Mock } from 'vitest';
import { JjService } from '../../jj-service';
import { showJjError } from '../../commands/command-utils';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TestRepo } from '../test-repo';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../vscode-mock');
    return createVscodeMock({
        // Overrides
        window: { showErrorMessage: vi.fn() },
    });
});

describe('Index Lock Error Handling', () => {
    let repo: TestRepo;
    let jjService: JjService;

    afterEach(() => {
        vi.clearAllMocks();
        if (repo) {
            repo.dispose();
        }
    });

    describe('JjService with real lock file', () => {
        test('commit command triggers lock error and showJjError can delete it', async () => {
            repo = new TestRepo();
            repo.init();

            const mockLogger = vi.fn();
            jjService = new JjService(repo.path, mockLogger);

            // Create a fake lock file
            const lockPath = path.join(repo.path, '.git', 'index.lock');
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.writeFileSync(lockPath, '');

            // Re-mock to return 'Delete Lock File' action
            const showErrorMessage = vscode.window.showErrorMessage as Mock;
            showErrorMessage.mockResolvedValueOnce('Delete Lock File');

            try {
                // This should throw an error because the index is locked during git export
                await jjService.commit('test commit');
                expect.unreachable('Expected commit to throw an error due to index.lock');
            } catch (e: unknown) {
                // Verify the error is recognized
                expect(JjService.isIndexLockError(e)).toBe(true);

                const mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;
                const result = await showJjError(e, 'Prefix', jjService, mockOutputChannel, []);

                // Verify recovery
                expect(result).toBe('Delete Lock File');
                expect(fs.existsSync(lockPath)).toBe(false);
                expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Deleted lock file'));

                // Verify that another commit will now succeed
                await expect(jjService.commit('test commit 2')).resolves.not.toThrow();
            }
        });
    });

    describe('JjService.isIndexLockError patterns', () => {
        test('returns true for known lock error patterns', () => {
            const error1 = new Error('Could not acquire lock for index file');
            const error2 = new Error('Error: .git/index.lock already exists');
            const error3 = 'Some string error with index.lock in it';

            expect(JjService.isIndexLockError(error1)).toBe(true);
            expect(JjService.isIndexLockError(error2)).toBe(true);
            expect(JjService.isIndexLockError(error3)).toBe(true);
        });

        test('returns false for unrelated errors', () => {
            const error1 = new Error('Permission denied');
            const error2 = new Error('No such file or directory');
            const error3 = 'Not a jj repository';

            expect(JjService.isIndexLockError(error1)).toBe(false);
            expect(JjService.isIndexLockError(error2)).toBe(false);
            expect(JjService.isIndexLockError(error3)).toBe(false);
        });
    });

    describe('showJjError with mock errors', () => {
        let testRepo: TestRepo;
        let jjService: JjService;

        beforeEach(() => {
            testRepo = new TestRepo();
            testRepo.init();

            const mockLogger = vi.fn();
            jjService = new JjService(testRepo.path, mockLogger);
        });

        afterEach(() => {
            if (testRepo) {
                testRepo.dispose();
            }
        });

        test('adds Delete Lock File action for lock errors with repository root', async () => {
            const error = new Error('Could not acquire lock for index file');
            const mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;

            // Re-mock to return standard selection
            const showErrorMessage = vscode.window.showErrorMessage as Mock;
            showErrorMessage.mockResolvedValueOnce(undefined);

            await showJjError(error, 'Prefix', jjService, mockOutputChannel, []);

            expect(showErrorMessage).toHaveBeenCalledWith(
                'Prefix: Git index is locked. Another process may have crashed. Delete .git/index.lock to resolve.',
                'Show Log',
                'Delete Lock File',
            );
        });

        test('deletes lock file when action is selected', async () => {
            const error = new Error('Could not acquire lock for index file');
            const mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;

            const lockPath = path.join(testRepo.path, '.git', 'index.lock');
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.writeFileSync(lockPath, '');

            // Re-mock to return 'Delete Lock File' action
            const showErrorMessage = vscode.window.showErrorMessage as Mock;
            showErrorMessage.mockResolvedValueOnce('Delete Lock File');

            const result = await showJjError(error, 'Prefix', jjService, mockOutputChannel, []);

            expect(result).toBe('Delete Lock File');
            expect(fs.existsSync(lockPath)).toBe(false);
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('Deleted lock file'));
        });

        test('does not add action if repo root is missing', async () => {
            const error = new Error('Could not acquire lock for index file');
            const mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;

            // Create a separate service pointing to an empty non-jj directory
            const emptyDirRepo = new TestRepo(); // not calling init()
            const emptyJjService = new JjService(emptyDirRepo.path, vi.fn());

            const showErrorMessage = vscode.window.showErrorMessage as Mock;
            showErrorMessage.mockResolvedValueOnce(undefined);

            try {
                await showJjError(error, 'Prefix', emptyJjService, mockOutputChannel, []);
            } finally {
                emptyDirRepo.dispose();
            }

            expect(showErrorMessage).toHaveBeenCalledWith(
                'Prefix: Could not acquire lock for index file', // Original simple message
                'Show Log',
                // No Delete Lock File
            );
        });

        test('does not duplicate Delete Lock File action if already present', async () => {
            const error = new Error('Could not acquire lock for index file');
            const mockOutputChannel = { appendLine: vi.fn(), show: vi.fn() } as unknown as vscode.OutputChannel;

            const showErrorMessage = vscode.window.showErrorMessage as Mock;
            showErrorMessage.mockResolvedValueOnce(undefined);

            await showJjError(error, 'Prefix', jjService, mockOutputChannel, ['Delete Lock File']);

            expect(showErrorMessage).toHaveBeenCalledWith(
                'Prefix: Git index is locked. Another process may have crashed. Delete .git/index.lock to resolve.',
                'Show Log',
                'Delete Lock File',
            );
        });
    });
});
