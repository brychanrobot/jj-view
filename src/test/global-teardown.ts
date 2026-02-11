/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mocha Root Hook Plugin.
// afterAll runs once after ALL suites finish, cleaning up test repos by prefix.
// This avoids race conditions where VS Code file watchers are still active
// when individual test teardowns delete their repos.
export const mochaHooks = {
    afterAll() {
        const tmpDir = os.tmpdir();
        const entries = fs.readdirSync(tmpDir);
        for (const entry of entries) {
            if (entry.startsWith('jj-view-test-')) {
                const fullPath = path.join(tmpDir, entry);
                try {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                } catch {
                    // Ignore cleanup errors
                }
            }
        }
    },
};
