/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SetupSidecarOptions {
    workspaceRoot?: string;
    globalConfigDir?: string;
    forceRebuild?: boolean;
}

export function setupSidecar(options?: SetupSidecarOptions): void {
    const rootDir = options?.workspaceRoot ?? path.resolve(__dirname, '..');
    const binName = process.platform === 'win32' ? 'jj-view.exe' : 'jj-view';
    const binPath = path.join(rootDir, 'dist', 'bin', binName);

    if (!fs.existsSync(binPath) || options?.forceRebuild) {
        console.info(`[Setup Sidecar] Compiling binary at dist/bin/${binName}...`);
        execFileSync('go', ['build', '-o', `dist/bin/${binName}`, './cmd/jj-view'], {
            cwd: rootDir,
            stdio: 'inherit',
        });
    }

    if (!fs.existsSync(binPath)) {
        throw new Error(`Failed to locate compiled binary at: ${binPath}`);
    }

    const homeDir = os.homedir();
    const configDir = options?.globalConfigDir ?? path.join(homeDir, '.gemini', 'config');

    console.info(`[Setup Sidecar] Running native installer from ${binPath}...`);
    execFileSync(binPath, ['install-antigravity-plugin', '--config-dir', configDir, '--binary-path', binPath], {
        stdio: 'inherit',
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    setupSidecar();
}
