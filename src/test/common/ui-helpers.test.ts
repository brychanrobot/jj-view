/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeForgeRegistry } from '../../code-forge-registry';
import {
    promptForRevision,
    promptSelectOrCreate,
    resolveRepository,
    showJjError,
    withDelayedProgress,
} from '../../common/ui-helpers';
import { JjRepositoryManager } from '../../jj-repository-manager';
import { JjService, NO_OP_LOGGER } from '../../jj-service';
import { Uri } from '../../uri-utils';
import { FakeHostEnvironment, FakeHostUi } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMockLogOutputChannel } from '../test-utils';
import '../vitest-utils';

describe('ui-helpers', () => {
    describe('promptSelectOrCreate', () => {
        let ui: FakeHostUi;

        beforeEach(() => {
            ui = new FakeHostUi();
        });

        it('returns selected item label when picked from quick pick', async () => {
            ui.showQuickPick = vi.fn().mockResolvedValue({ label: 'feat/test', description: 'Move bookmark' });

            const result = await promptSelectOrCreate(ui, {
                placeHolder: 'Select bookmark',
                items: [{ label: 'feat/test', description: 'Move bookmark' }],
            });

            expect(result).toBe('feat/test');
            expect(ui.showQuickPick).toHaveBeenCalledWith(
                [{ label: 'feat/test', description: 'Move bookmark' }],
                expect.objectContaining({ placeHolder: 'Select bookmark' }),
            );
        });

        it('returns custom value from quick pick custom input', async () => {
            ui.showQuickPick = vi.fn().mockResolvedValue({ customValue: 'new-bookmark-name' });

            const result = await promptSelectOrCreate(ui, {
                placeHolder: 'Select bookmark',
                items: [{ label: 'feat/test' }],
            });

            expect(result).toBe('new-bookmark-name');
        });

        it('returns undefined when quick pick is cancelled', async () => {
            ui.showQuickPick = vi.fn().mockResolvedValue(undefined);

            const result = await promptSelectOrCreate(ui, {
                placeHolder: 'Select bookmark',
                items: [{ label: 'feat/test' }],
            });

            expect(result).toBeUndefined();
        });
    });

    describe('promptForRevision', () => {
        let repo: TestRepo;
        let jj: JjService;
        let ui: FakeHostUi;

        beforeEach(() => {
            repo = new TestRepo();
            repo.init();
            jj = new JjService(repo.path, NO_OP_LOGGER);
            ui = new FakeHostUi();
        });

        it('returns selected revision detail from quick pick', async () => {
            const ids = await buildGraph(repo, [
                { label: 'v1', files: { 'file1.txt': 'v1\n' } },
                { label: 'v2', parents: ['v1'], files: { 'file1.txt': 'v2\n' } },
            ]);

            ui.showQuickPick = vi.fn().mockResolvedValue({
                label: 'v2',
                detail: ids.v2.changeId,
            });

            const result = await promptForRevision(ui, jj, { revisionQuery: 'all()' });

            expect(result).toBe(ids.v2.changeId);
            expect(ui.showQuickPick).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        detail: ids.v2.changeId,
                    }),
                ]),
                expect.objectContaining({ placeHolder: 'Select target revision' }),
            );
        });

        it('returns customValue if user typed a revision not in the list', async () => {
            ui.showQuickPick = vi.fn().mockResolvedValue({
                customValue: 'main@origin',
            });

            const result = await promptForRevision(ui, jj, { revisionQuery: 'all()' });

            expect(result).toBe('main@origin');
        });

        it('returns undefined if user cancels quick pick', async () => {
            ui.showQuickPick = vi.fn().mockResolvedValue(undefined);

            const result = await promptForRevision(ui, jj, { revisionQuery: 'all()' });

            expect(result).toBeUndefined();
        });

        it('falls back to showInputBox if jj getLog throws', async () => {
            ui.showInputBox = vi.fn().mockResolvedValue('fallback-rev');

            const result = await promptForRevision(ui, jj, { revisionQuery: 'invalid(syntax' });

            expect(result).toBe('fallback-rev');
            expect(ui.showInputBox).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Enter revision' }));
        });

        it('supports RevisionQuery expressions', async () => {
            const ids = await buildGraph(repo, [
                { label: 'p1', files: { 'file1.txt': 'p1\n' } },
                { label: 'c1', parents: ['p1'], files: { 'file1.txt': 'c1\n' } },
            ]);

            ui.showQuickPick = vi.fn().mockResolvedValue({
                label: 'p1',
                detail: ids.p1.changeId,
            });

            const result = await promptForRevision(ui, jj, {
                revisionQuery: 'ancestors(@)',
            });

            expect(result).toBe(ids.p1.changeId);
        });
    });

    describe('showJjError', () => {
        let repo: TestRepo;
        let jj: JjService;
        let ui: FakeHostUi;

        beforeEach(() => {
            repo = new TestRepo();
            repo.init();
            jj = new JjService(repo.path, NO_OP_LOGGER);
            ui = new FakeHostUi();
        });

        it('displays error message and logs error', async () => {
            const log = createMockLogOutputChannel();
            ui.showErrorMessage = vi.fn().mockResolvedValue(undefined);

            const err = new Error('Working copy is dirty');
            await showJjError(ui, err, 'Commit Error', jj, log);

            expect(log.error).toHaveBeenCalledWith('Commit Error: Working copy is dirty', err);
            expect(ui.showErrorMessage).toHaveBeenCalledWith('Commit Error: Working copy is dirty', 'Show Log');
        });

        it('opens log when Show Log action is selected', async () => {
            const log = createMockLogOutputChannel();
            ui.setNextErrorResponse('Show Log');

            const err = new Error('Something failed');
            const result = await showJjError(ui, err, 'Error', jj, log);

            expect(result).toBe('Show Log');
            expect(log.show).toHaveBeenCalled();
        });

        it('passes extra actions and returns selected extra action', async () => {
            const log = createMockLogOutputChannel();
            ui.setNextErrorResponse('Configure Upload...');

            const err = new Error('No upload command');
            const result = await showJjError(ui, err, 'Upload Error', jj, log, ['Configure Upload...']);

            expect(result).toBe('Configure Upload...');
        });

        it('detects Git index lock error and deletes lock file when chosen', async () => {
            const log = createMockLogOutputChannel();
            const lockPath = path.join(repo.path, '.git', 'index.lock');
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.writeFileSync(lockPath, '');

            ui.setNextErrorResponse('Delete Lock File');

            const err = new Error('Could not acquire lock for index file');
            const result = await showJjError(ui, err, 'Git Error', jj, log);

            expect(result).toBe('Delete Lock File');
            expect(fs.existsSync(lockPath)).toBe(false);
            expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Deleted lock file'));
        });
    });

    describe('withDelayedProgress', () => {
        let ui: FakeHostUi;

        beforeEach(() => {
            ui = new FakeHostUi();
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('returns task result without progress notification if fast', async () => {
            const task = () => Promise.resolve(42);

            const promise = withDelayedProgress(ui, 'Fast operation', task, 100);
            vi.advanceTimersByTime(50);
            const result = await promise;

            expect(result).toBe(42);
        });

        it('shows progress notification if task takes longer than delay', async () => {
            let finishTask!: (val: string) => void;
            const task = () =>
                new Promise<string>((resolve) => {
                    finishTask = resolve;
                });

            const promise = withDelayedProgress(ui, 'Slow operation', task, 100);
            vi.advanceTimersByTime(150);

            finishTask('done');
            const result = await promise;

            expect(result).toBe('done');
        });

        it('propagates errors from task', async () => {
            const task = () => Promise.reject(new Error('boom'));

            await expect(withDelayedProgress(ui, 'Failing op', task, 100)).rejects.toThrow('boom');
        });
    });

    describe('resolveRepository', () => {
        let repo: TestRepo;
        let repoManager: JjRepositoryManager;
        let host: FakeHostEnvironment;

        beforeEach(async () => {
            repo = new TestRepo();
            repo.init();

            host = new FakeHostEnvironment();
            host.workspace.addFolder(Uri.file(repo.path));

            const codeForgeRegistry = new CodeForgeRegistry();
            const outputChannel = createMockLogOutputChannel();

            repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, host);
            await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
        });

        afterEach(async () => {
            await repoManager.dispose();
        });

        it('resolves repository from activeUri', () => {
            const fileUri = Uri.file(path.join(repo.path, 'sub', 'file.txt'));
            const resolved = resolveRepository(repoManager, { activeUri: fileUri });

            expect(resolved).toBeDefined();
            expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
        });

        it('resolves repository from custom jj-commit scheme activeUri', () => {
            const commitUri = Uri.from({
                scheme: 'jj-commit',
                path: '/Commit',
                fragment: `repoRoot=${encodeURIComponent(repo.path)}`,
            });
            const resolved = resolveRepository(repoManager, { activeUri: commitUri });

            expect(resolved).toBeDefined();
            expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
        });

        it('resolves repository from args object containing rootUri', () => {
            const scmArg = { rootUri: Uri.file(repo.path) };
            const resolved = resolveRepository(repoManager, { args: [scmArg] });

            expect(resolved).toBeDefined();
            expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
        });

        it('resolves repository from resource group argument with resourceStates', () => {
            const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
            const groupArg = { resourceStates: [{ resourceUri: fileUri }] };
            const resolved = resolveRepository(repoManager, { args: [groupArg] });

            expect(resolved).toBeDefined();
            expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
        });

        it('resolves repository from direct URI argument in args', () => {
            const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
            const resolved = resolveRepository(repoManager, { args: [fileUri] });

            expect(resolved).toBeDefined();
            expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
        });

        it('resolves repository from host.documents.getActiveDocumentUri', () => {
            const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
            host.documents.setActiveDocument(fileUri);
            const resolved = resolveRepository(repoManager, {
                host,
            });

            expect(resolved).toBeDefined();
            expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
        });

        it('falls back to focusedRepository if no active uri or args match', () => {
            const registered = repoManager.getRepositoryForUri(Uri.file(repo.path));
            repoManager.setFocusedRepository(registered);

            const resolved = resolveRepository(repoManager);
            expect(resolved).toBe(registered);
        });
    });
});
