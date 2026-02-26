/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execFileAsync = promisify(execFile);

describe('Shell and Batch Scripts', () => {
    let tmpDir: string;
    let scriptsDir: string;
    const isWin = process.platform === 'win32';

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-script-test-'));
        scriptsDir = path.resolve(__dirname, '../../scripts');
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    describe('conflict-capture', () => {
        test('copies base, left, and right files to output directory', async () => {
            const outDir = path.join(tmpDir, 'conflict-out');
            await fs.mkdir(outDir, { recursive: true });

            const baseFile = path.join(tmpDir, 'base.txt');
            const leftFile = path.join(tmpDir, 'left.txt');
            const rightFile = path.join(tmpDir, 'right.txt');

            await fs.writeFile(baseFile, 'base', 'utf8');
            await fs.writeFile(leftFile, 'left', 'utf8');
            await fs.writeFile(rightFile, 'right', 'utf8');

            const scriptArgs = [baseFile, leftFile, rightFile, outDir];

            try {
                if (isWin) {
                    await execFileAsync(path.join(scriptsDir, 'conflict-capture.bat'), scriptArgs, { shell: true });
                } else {
                    await execFileAsync(path.join(scriptsDir, 'conflict-capture.sh'), scriptArgs);
                }
            } catch (err: unknown) {
                // We expect it to exit with code 1 so jj resolve aborts
                expect((err as { code?: number }).code).toBe(1);
            }

            expect(await fs.readFile(path.join(outDir, 'base'), 'utf8')).toBe('base');
            expect(await fs.readFile(path.join(outDir, 'left'), 'utf8')).toBe('left');
            expect(await fs.readFile(path.join(outDir, 'right'), 'utf8')).toBe('right');
        });
    });
    
    describe('batch-diff', () => {
        test('copies left and right directories', async () => {
             const leftDir = path.join(tmpDir, 'batch-diff-l');
             const rightDir = path.join(tmpDir, 'batch-diff-r');
             
             await fs.mkdir(path.join(leftDir, 'folder'), { recursive: true });
             await fs.mkdir(path.join(rightDir, 'folder'), { recursive: true });
             
             await fs.writeFile(path.join(leftDir, 'folder', 'l.txt'), 'l', 'utf8');
             await fs.writeFile(path.join(rightDir, 'folder', 'r.txt'), 'r', 'utf8');
             
             const outLeftDir = path.join(tmpDir, 'batch-diff-out-l');
             const outRightDir = path.join(tmpDir, 'batch-diff-out-r');
             
             // The script copies to out folders
             try {
                 if (isWin) {
                     await execFileAsync(path.join(scriptsDir, 'batch-diff.bat'), [leftDir, rightDir, outLeftDir, outRightDir], { shell: true });
                 } else {
                     await execFileAsync(path.join(scriptsDir, 'batch-diff.sh'), [leftDir, rightDir, outLeftDir, outRightDir]);
                 }
             } catch(err: unknown) {
                 expect((err as { code?: number }).code).toBe(1);
             }
             
             expect(await fs.readFile(path.join(outLeftDir, 'folder', 'l.txt'), 'utf8')).toBe('l');
             expect(await fs.readFile(path.join(outRightDir, 'folder', 'r.txt'), 'utf8')).toBe('r');
        });
    });
    
    describe('batch-edit', () => {
        test('copies multiple files to destination directories', async () => {
            const leftDir = path.join(tmpDir, 'batch-edit-l');
            const rightDir = path.join(tmpDir, 'batch-edit-r');
            
            await fs.mkdir(leftDir, { recursive: true });
            await fs.mkdir(rightDir, { recursive: true });
            
            const src1 = path.join(tmpDir, 'src1.txt');
            const src2 = path.join(tmpDir, 'src2.txt');
            
            await fs.writeFile(src1, 'write1', 'utf8');
            await fs.writeFile(src2, 'write2', 'utf8');
            
            const dest1 = path.join('nested', 'target1.txt');
            const dest2 = 'target2.txt';
            
            try {
                 if (isWin) {
                     await execFileAsync(path.join(scriptsDir, 'batch-edit.bat'), [leftDir, rightDir, src1, dest1, src2, dest2], { shell: true });
                 } else {
                     await execFileAsync(path.join(scriptsDir, 'batch-edit.sh'), [leftDir, rightDir, src1, dest1, src2, dest2]);
                 }
             } catch(err: unknown) {
                 expect((err as { code?: number }).code).toBe(0);
             }
             
             expect(await fs.readFile(path.join(rightDir, 'nested', 'target1.txt'), 'utf8')).toBe('write1');
             expect(await fs.readFile(path.join(rightDir, 'target2.txt'), 'utf8')).toBe('write2');
        });
    });
});
