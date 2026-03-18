/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JjService } from '../jj-service';
import { TestRepo } from './test-repo';

describe('JjService Subdirectory Mapping', () => {
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
    });

    afterEach(() => {
        repo.dispose();
    });

    test('getRepoRoot returns the true repo root from a subdirectory', async () => {
        const workspacePath = path.join(repo.path, 'subdirectory');
        fs.mkdirSync(workspacePath);

        const subService = new JjService(workspacePath);
        const discoveredRoot = await subService.getRepoRoot();

        // Ask jj to evaluate the repository root from the top-level repo path
        // to get the exact canonicalized string format that Rust generates
        // for this system. This avoids Node.js string-matching quirks with
        // Windows 8.3 short paths or macOS symlinks altogether!
        const rootService = new JjService(repo.path);
        const expectedRoot = await rootService.getRepoRoot();

        expect(discoveredRoot).toBe(expectedRoot);
    });

    test('getDiffContent correctly maps paths in subdirectory workspace', async () => {
        const workspacePath = path.join(repo.path, 'google3');
        fs.mkdirSync(workspacePath);

        const fileName = 'test.txt';
        const fileRepoRelativePath = 'google3/test.txt';
        const absoluteFilePath = path.join(workspacePath, fileName);

        repo.writeFile(fileRepoRelativePath, 'v1');
        repo.snapshot();
        repo.describe('v1');

        repo.new();
        repo.writeFile(fileRepoRelativePath, 'v2');

        const subService = new JjService(workspacePath);

        // This should use the bulk cache and find the file at google3/test.txt
        const diff = await subService.getDiffContent('@', absoluteFilePath);

        expect(diff.left).toBe('v1');
        expect(diff.right).toBe('v2');

        // Verify that we didn't fall back (no log entry for fallback should be in captured output if we had a way to check it,
        // but the fact that it returns correct content is already a win)
    });
});
