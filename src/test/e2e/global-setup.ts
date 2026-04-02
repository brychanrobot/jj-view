/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

/**
 * Downloads and unzips VS Code sequentially before Playwright spawns parallel
 * worker threads, preventing race conditions (e.g., 'tar: Cannot mkdir') when
 * multiple workers attempt to extract the archive to the same directory.
 */
async function globalSetup() {
    process.stdout.write('Downloading and unzipping VS Code (Global Setup)...\n');
    await downloadAndUnzipVSCode();
    process.stdout.write('VS Code download complete.\n');
}

export default globalSetup;
