/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import * as cp from 'child_process';

/**
 * Resolves the path to the 'jj' binary by verifying it through 'jj --version'.
 *
 * Logic:
 * 1. If preferredPath is provided, verify it by running `${path} --version`.
 * 2. If no path is provided, try running `jj --version` (letting the OS find it in PATH).
 *
 * Throws a descriptive error if preferredPath is set but invalid or fails the version check.
 * Returns undefined if default discovery ('jj') fails.
 */
export async function resolveJjBinary(preferredPath?: string, workspaceRoot?: string): Promise<string | undefined> {
    // 1. Check preferred path
    if (preferredPath && preferredPath.trim().length > 0) {
        const absolutePath = path.isAbsolute(preferredPath)
            ? preferredPath
            : workspaceRoot
              ? path.resolve(workspaceRoot, preferredPath)
              : undefined;

        if (!absolutePath) {
            throw new Error(`Could not resolve relative path: ${preferredPath}`);
        }

        const version = await getJjVersion(absolutePath);
        if (!version) {
            throw new Error(`'${preferredPath}' is not a valid 'jj' binary (could not get version).`);
        }
        return absolutePath;
    }

    // 2. Try default 'jj' (relies on PATH)
    const version = await getJjVersion('jj');
    if (version) {
        return 'jj';
    }

    // If we've reached here, we haven't found a working jj.
    return undefined;
}

/**
 * Executes a 'jj --version' command to verify if a path points to a valid jj binary.
 * Returns the version string (e.g., '0.14.0') if successful, or undefined otherwise.
 */
async function getJjVersion(binaryPath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        cp.execFile(binaryPath, ['--version'], { timeout: 2000 }, (err, stdout) => {
            if (err) {
                resolve(undefined);
                return;
            }

            // Expected output format: "jj 0.39.0" or similar
            const match = stdout.trim().match(/^jj\s+(\d+\.\d+\.\d+)/);
            if (match) {
                resolve(match[1]);
            } else {
                resolve(undefined);
            }
        });
    });
}
