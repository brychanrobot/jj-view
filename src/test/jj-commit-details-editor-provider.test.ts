/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test, vi } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { mergeFileConflictStatus } from '../jj-commit-details-editor-provider';

test('mergeFileConflictStatus marks diff entries and adds conflict-only files', () => {
    const files = mergeFileConflictStatus(
        [{ path: 'changed.txt', status: 'modified', additions: 2, deletions: 1 }],
        ['changed.txt', 'conflict only.txt'],
    );

    expect(files).toEqual([
        { path: 'changed.txt', status: 'modified', additions: 2, deletions: 1, conflicted: true },
        { path: 'conflict only.txt', status: 'modified', conflicted: true },
    ]);
});
