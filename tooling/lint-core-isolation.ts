/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function getAllSourceFiles(dirPath: string): string[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...getAllSourceFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            files.push(fullPath);
        }
    }

    return files;
}

const coreDir = path.resolve(process.cwd(), 'src/core');
const sourceFiles = getAllSourceFiles(coreDir);

if (sourceFiles.length === 0) {
    console.error('Error: No source files found in src/core/');
    process.exit(1);
}

const violations: Array<{ file: string; line: number; content: string }> = [];
const vscodeImportPattern =
    /(from\s+['"]vscode['"]|require\s*\(\s*['"]vscode['"]\s*\)|import\s*\(\s*['"]vscode['"]\s*\))/;

for (const filePath of sourceFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        // Ignore comments
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            return;
        }

        if (vscodeImportPattern.test(line)) {
            violations.push({
                file: path.relative(process.cwd(), filePath),
                line: index + 1,
                content: trimmed,
            });
        }
    });
}

if (violations.length > 0) {
    console.error(`\n[LINT ERROR] Forbidden 'vscode' import(s) detected in src/core/:`);
    for (const v of violations) {
        console.error(`  ${v.file}:${v.line} -> ${v.content}`);
    }
    console.error(
        `\nsrc/core/ must remain completely platform-agnostic with zero vscode imports. Use HostEnvironment or RpcBridge instead.\n`,
    );
    process.exit(1);
}

console.log(`Core isolation lint passed: ${sourceFiles.length} files in src/core/ are 100% free of vscode imports.`);
process.exit(0);
