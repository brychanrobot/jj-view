/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { JjService } from '../../core/jj-service';
import type { JjLogEntry } from '../../core/jj-types';
import type { ScmModel, ScmSnapshot } from '../../core/scm-model';
import { createJjResourceState } from '../../core/scm-resource-state';
import type { Uri } from '../../core/uri-utils';
import { WebCommandDispatcher } from '../../web/commands/web-command-dispatcher';
import { createMock } from '../test-utils';

interface MockScmModelResult {
    scmModel: ScmModel;
    mockJj: {
        new: ReturnType<typeof vi.fn>;
        commit: ReturnType<typeof vi.fn>;
        abandon: ReturnType<typeof vi.fn>;
        squashRevision: ReturnType<typeof vi.fn>;
        absorb: ReturnType<typeof vi.fn>;
        edit: ReturnType<typeof vi.fn>;
    };
    abandonCalls: string[][];
    refreshCalls: unknown[];
    commitCalls: string[];
    setDescriptionCalls: string[];
    restoreCalls: string[][];
    squashCalls: unknown[];
    editCalls: string[];
}

function createMockScmModel(): MockScmModelResult {
    const abandonCalls: string[][] = [];
    const refreshCalls: unknown[] = [];
    const commitCalls: string[] = [];
    const setDescriptionCalls: string[] = [];
    const restoreCallsList: string[][] = [];
    const squashCalls: unknown[] = [];
    const editCalls: string[] = [];

    const mockJj = {
        new: vi.fn(async () => 'new-commit'),
        commit: vi.fn(async (msg: string) => {
            commitCalls.push(msg);
        }),
        abandon: vi.fn(async (revisions: string[]) => {
            abandonCalls.push(revisions);
            return 'abandoned';
        }),
        squashRevision: vi.fn(async (options: unknown) => {
            squashCalls.push(options);
        }),
        absorb: vi.fn(async () => 'absorbed'),
        edit: vi.fn(async (rev: string) => {
            editCalls.push(rev);
            return 'edited';
        }),
    };

    const mockModel = createMock<ScmModel>({
        jj: createMock<JjService>(mockJj),
        snapshot: createMock<ScmSnapshot>({
            currentEntry: createMock<JjLogEntry>({
                commit_id: 'current-working-copy-1234',
                change_id: 'qpvunstz',
                description: 'current wc desc',
            }),
            description: 'current wc desc',
        }),
        refresh: vi.fn(async (opts?: unknown) => {
            refreshCalls.push(opts);
        }),
        setDescription: vi.fn(async (msg: string) => {
            setDescriptionCalls.push(msg);
        }),
        restore: vi.fn(async (paths: string[]) => {
            restoreCallsList.push(paths);
        }),
        abandon: vi.fn(async (revisions: string[]) => {
            abandonCalls.push(revisions);
        }),
    });

    return {
        scmModel: mockModel,
        mockJj,
        abandonCalls,
        refreshCalls,
        commitCalls,
        setDescriptionCalls,
        restoreCalls: restoreCallsList,
        squashCalls,
        editCalls,
    };
}

describe('WebCommandDispatcher', () => {
    it('abandons targeted ancestor commit instead of working copy', async () => {
        const mock = createMockScmModel();
        const dispatcher = new WebCommandDispatcher({ scmModel: mock.scmModel });

        // User clicks abandon on ancestor group @-1
        await dispatcher.execute('jj-view.abandon', {
            groupId: 'ancestor-0',
            ancestor: {
                entry: {
                    commit_id: 'ancestor-commit-5678',
                    change_id: 'krsyowsw',
                },
            },
        });

        // Verifies ancestor commit is abandoned, NOT the current working copy commit
        expect(mock.abandonCalls).toHaveLength(1);
        expect(mock.abandonCalls[0]).toEqual(['ancestor-commit-5678']);
        expect(mock.abandonCalls[0]).not.toEqual(['current-working-copy-1234']);
    });

    it('falls back to current working copy when abandoning without ancestor payload', async () => {
        const mock = createMockScmModel();
        const dispatcher = new WebCommandDispatcher({ scmModel: mock.scmModel });

        await dispatcher.execute('jj-view.abandon');

        expect(mock.abandonCalls).toHaveLength(1);
        expect(mock.abandonCalls[0]).toEqual(['current-working-copy-1234']);
    });

    it('respects confirmation callback when abandoning', async () => {
        const mock = createMockScmModel();
        let confirmCalled = false;
        const dispatcher = new WebCommandDispatcher({
            scmModel: mock.scmModel,
            onConfirm: async () => {
                confirmCalled = true;
                return false; // User cancels
            },
        });

        await dispatcher.execute('jj-view.abandon');

        expect(confirmCalled).toBe(true);
        expect(mock.abandonCalls).toHaveLength(0); // Cancelled
    });

    it('dispatches new, commit, setDescription, refresh, absorb, and edit', async () => {
        const mock = createMockScmModel();
        const dispatcher = new WebCommandDispatcher({ scmModel: mock.scmModel });

        await dispatcher.execute('jj-view.new');
        expect(mock.mockJj.new).toHaveBeenCalledTimes(1);

        await dispatcher.execute('jj-view.commit', 'feat: my commit');
        expect(mock.commitCalls).toEqual(['feat: my commit']);

        await dispatcher.execute('jj-view.setDescription', 'new description');
        expect(mock.setDescriptionCalls).toEqual(['new description']);

        await dispatcher.execute('jj-view.refresh');
        expect(mock.refreshCalls.length).toBeGreaterThan(0);

        await dispatcher.execute('jj-view.absorb');
        expect(mock.mockJj.absorb).toHaveBeenCalledTimes(1);

        await dispatcher.execute('jj-view.edit', {
            ancestor: { entry: { commit_id: 'ancestor-999' } },
        });
        expect(mock.editCalls).toEqual(['ancestor-999']);
    });

    it('dispatches openChanges and openFile to context callbacks', async () => {
        const mock = createMockScmModel();
        let openedDiffTitle: string | undefined;
        let openedFileUri: Uri | undefined;

        const dispatcher = new WebCommandDispatcher({
            scmModel: mock.scmModel,
            onOpenDiff: (_left, _right, title) => {
                openedDiffTitle = title;
            },
            onOpenFile: (uri) => {
                openedFileUri = uri;
            },
        });

        const state = createJjResourceState({ path: 'src/file.ts', status: 'modified' }, '@', '/repo');

        await dispatcher.execute('vscode.diff', state);
        expect(openedDiffTitle).toContain('src/file.ts');

        await dispatcher.execute('vscode.open', state);
        expect(openedFileUri?.path).toContain('src/file.ts');
    });

    it('catches execution errors and forwards to onError callback', async () => {
        const mock = createMockScmModel();
        let reportedError: Error | undefined;

        mock.scmModel.jj.new = vi.fn(async () => {
            throw new Error('Command failed: jj new');
        });

        const dispatcher = new WebCommandDispatcher({
            scmModel: mock.scmModel,
            onError: (err) => {
                reportedError = err;
            },
        });

        await dispatcher.execute('jj-view.new');
        expect(reportedError).toBeDefined();
        expect(reportedError?.message).toBe('Command failed: jj new');
    });
});
