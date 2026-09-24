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
        } else if (
            entry.isFile() &&
            (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.svelte'))
        ) {
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

const violations: Array<{ file: string; line: number; content: string; reason: string }> = [];
const vscodeImportPattern =
    /(from\s+['"]vscode(\/.*)?['"]|require\s*\(\s*['"]vscode(\/.*)?['"]\s*\)|import\s*\(?\s*['"]vscode(\/.*)?['"])/;
const pathImportPattern =
    /(from\s+['"](node:path|path)(\/.*)?['"]|require\s*\(\s*['"](node:path|path)(\/.*)?['"]\s*\)|import\s*\(?\s*['"](node:path|path)(\/.*)?['"])/;
const cryptoImportPattern =
    /(from\s+['"](node:crypto|crypto)(\/.*)?['"]|require\s*\(\s*['"](node:crypto|crypto)(\/.*)?['"]\s*\)|import\s*\(?\s*['"](node:crypto|crypto)(\/.*)?['"])/;

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
                reason: "Forbidden 'vscode' import. Use HostEnvironment or RpcBridge instead.",
            });
        }

        if (pathImportPattern.test(line)) {
            violations.push({
                file: path.relative(process.cwd(), filePath),
                line: index + 1,
                content: trimmed,
                reason: "Forbidden 'node:path' or 'path' import in src/core/. Use 'pathe' instead.",
            });
        }

        if (cryptoImportPattern.test(line)) {
            violations.push({
                file: path.relative(process.cwd(), filePath),
                line: index + 1,
                content: trimmed,
                reason: "Forbidden 'node:crypto' or 'crypto' import in src/core/. Use portable utilities like 'fnv1aHash'.",
            });
        }
    });
}

if (violations.length > 0) {
    console.error(`\n[LINT ERROR] Forbidden import(s) detected in src/core/:`);
    for (const v of violations) {
        console.error(`  ${v.file}:${v.line} -> ${v.content} (${v.reason})`);
    }
    console.error(`\nsrc/core/ must remain completely platform-agnostic and browser-compatible.\n`);
    process.exit(1);
}

console.log(
    `Core isolation lint passed: ${sourceFiles.length} files in src/core/ are 100% free of vscode, node:path, and node:crypto imports.`,
);
process.exit(0);
