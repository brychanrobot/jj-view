/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function getAllTestFiles(dirPath: string): string[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...getAllTestFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx'))) {
            files.push(fullPath);
        }
    }

    return files;
}

const testDir = path.resolve(process.cwd(), 'src/test');
const testFiles = getAllTestFiles(testDir);

if (testFiles.length === 0) {
    console.error('Error: No test files found in src/test/');
    process.exit(1);
}

const violations: Array<{ file: string; line: number; content: string }> = [];

// Matches expect(...fsPath).toBe(...) or expect(...fsPath).toEqual(...)
const forbiddenLeftSidePattern = /expect\([^)]*\b(?:fsPath)\b[^)]*\)\s*\.\s*(?:toBe|toEqual)\s*\(/;

// Matches expect(...).toBe(...fsPath) or expect(...).toBe(path.join(...)) or expect(...).toBe(repo.path)
// Excludes realpath comparisons which already canonicalize strings
const forbiddenRightSidePattern =
    /\.(?:toBe|toEqual)\(\s*(?!.*fs\.realpathSync)(?:[a-zA-Z0-9_.]*\bfsPath\b|path\.join\(|(?:repo|testRepo|testRepo2)\.path)\s*\)/;

for (const filePath of testFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        // Ignore comments
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            return;
        }

        if (forbiddenLeftSidePattern.test(line) || forbiddenRightSidePattern.test(line)) {
            violations.push({
                file: path.relative(process.cwd(), filePath),
                line: index + 1,
                content: trimmed,
            });
        }
    });
}

if (violations.length > 0) {
    console.error(`\n[LINT ERROR] Forbidden direct '.toBe()' or '.toEqual()' assertion on fsPath:`);
    for (const v of violations) {
        console.error(`  ${v.file}:${v.line} -> ${v.content}`);
    }
    console.error(
        `\nAlways use .toBeSameFsPath(...) instead of .toBe() or .toEqual() when comparing filesystem paths to avoid cross-platform Windows / POSIX test failures.\n`,
    );
    process.exit(1);
}

console.log(`Test fsPath assertion lint passed: ${testFiles.length} test files verified.`);
process.exit(0);
