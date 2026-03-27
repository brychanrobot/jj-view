/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolveJjBinary } from '../../utils/binary-utils';

describe('binary-utils real-file tests', () => {
    let tempDir: string;
    let oldHome: string | undefined;
    let oldPath: string | undefined;
    let oldUserProfile: string | undefined;
    let oldProgramFiles: string | undefined;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-binary-test-'));
        oldHome = process.env.HOME;
        oldPath = process.env.PATH;
        oldUserProfile = process.env.USERPROFILE;
        oldProgramFiles = process.env.ProgramFiles;
    });

    afterEach(() => {
        if (oldHome !== undefined) process.env.HOME = oldHome;
        else delete process.env.HOME;

        if (oldPath !== undefined) process.env.PATH = oldPath;
        else delete process.env.PATH;

        if (oldUserProfile !== undefined) process.env.USERPROFILE = oldUserProfile;
        else delete process.env.USERPROFILE;

        if (oldProgramFiles !== undefined) process.env.ProgramFiles = oldProgramFiles;
        else delete process.env.ProgramFiles;

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const createExecutable = (filePath: string, output: string = 'jj 0.1.0') => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        const goSourcePath = filePath + '.go';
        const goSource = `
package main
import (
    "fmt"
    "os"
)
func main() {
    if len(os.Args) > 1 && os.Args[1] == "--version" {
        fmt.Println("${output}")
    }
}
`;
        fs.writeFileSync(goSourcePath, goSource);
        cp.execFileSync('go', ['build', '-o', filePath, goSourcePath]);
        fs.unlinkSync(goSourcePath);
    };

    test('resolveJjBinary returns absolute path if it exists and is working', async () => {
        const binName = os.platform() === 'win32' ? 'jj.exe' : 'jj';
        const binPath = path.join(tempDir, binName);
        createExecutable(binPath);

        const result = await resolveJjBinary(binPath);
        expect(result).toBe(binPath);
    });

    test('resolveJjBinary throws if absolute path is not a working jj binary', async () => {
        const binPath = path.join(tempDir, 'not-jj');
        createExecutable(binPath, 'not jj');

        await expect(resolveJjBinary(binPath)).rejects.toThrow("is not a valid 'jj' binary");
    });

    test('resolveJjBinary throws if absolute path does not exist', async () => {
        const binPath = path.join(tempDir, 'non-existent-jj');
        // No file created
        await expect(resolveJjBinary(binPath)).rejects.toThrow("is not a valid 'jj' binary");
    });

    test('resolveJjBinary finds binary in PATH', async () => {
        const binDir = path.join(tempDir, 'bin');
        const binName = os.platform() === 'win32' ? 'jj.exe' : 'jj';
        const binPath = path.join(binDir, binName);
        createExecutable(binPath);

        process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;

        const result = await resolveJjBinary();
        // It returns 'jj' because it found it in PATH
        expect(result).toBe('jj');
    });

    test('resolveJjBinary returns undefined if nowhere to be found', async () => {
        // Clear everything
        process.env.PATH = '';
        const emptyHome = path.join(tempDir, 'empty-home');
        fs.mkdirSync(emptyHome);

        if (os.platform() === 'win32') {
            process.env.USERPROFILE = emptyHome;
        } else {
            process.env.HOME = emptyHome;
        }

        const result = await resolveJjBinary();
        expect(result).toBeUndefined();
    });

    test('resolveJjBinary resolves relative path from workspaceRoot', async () => {
        const workspaceRoot = path.join(tempDir, 'workspace');
        fs.mkdirSync(workspaceRoot);
        const binName = os.platform() === 'win32' ? 'jj.exe' : 'jj';
        const binPath = path.join(workspaceRoot, 'bin', binName);
        createExecutable(binPath);

        const result = await resolveJjBinary('./bin/' + binName, workspaceRoot);
        expect(result).toBe(binPath);
    });

    test('resolveJjBinary throws if relative path provided but no workspaceRoot', async () => {
        const relPath = './bin/jj';
        await expect(resolveJjBinary(relPath, undefined)).rejects.toThrow(
            `Could not resolve relative path: ${relPath}`,
        );
    });

    test('resolveJjBinary falls back to discovery if preferredPath is empty or whitespace', async () => {
        // Setup a binary in PATH so discovery succeeds
        const binDir = path.join(tempDir, 'bin');
        const binName = os.platform() === 'win32' ? 'jj.exe' : 'jj';
        const binPath = path.join(binDir, binName);
        createExecutable(binPath);
        process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;

        // Case: empty string
        const resultEmpty = await resolveJjBinary('');
        expect(resultEmpty).toBe('jj');

        // Case: whitespace
        const resultWhitespace = await resolveJjBinary('   ');
        expect(resultWhitespace).toBe('jj');
    });

    test('resolveJjBinary handles non-standard version strings', async () => {
        const binName = os.platform() === 'win32' ? 'jj-non-standard.exe' : 'jj-non-standard';
        const binPath = path.join(tempDir, binName);
        const versionString = 'jj 0.35-dev';
        createExecutable(binPath, versionString);

        const result = await resolveJjBinary(binPath);
        expect(result).toBe(binPath);
    });
});
