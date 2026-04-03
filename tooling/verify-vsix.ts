/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import AdmZip from 'adm-zip';
import * as fs from 'fs';

const vsixPath = process.argv[2];
if (!vsixPath) {
    console.error('Usage: ts-node scripts/verify-vsix.ts <vsix-path>');
    process.exit(1);
}

if (!fs.existsSync(vsixPath)) {
    console.error(`Error: File not found: ${vsixPath}`);
    process.exit(1);
}

const zip = new AdmZip(vsixPath);
const entries = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName);

// Essential platform-specific native binaries to check for a universal build.
// (Filenames in VSIX are prefixed with 'extension/')
const requiredEntries = [
    'extension/dist/node_modules/@parcel/watcher-linux-x64-glibc/watcher.node',
    'extension/dist/node_modules/@parcel/watcher-win32-x64/watcher.node',
    'extension/dist/node_modules/@parcel/watcher-darwin-arm64/watcher.node',
    // Runtime helper scripts
    'extension/scripts/batch-diff.sh',
    'extension/scripts/batch-diff.bat',
    'extension/scripts/batch-edit.sh',
    'extension/scripts/batch-edit.bat',
    'extension/scripts/conflict-capture.sh',
    'extension/scripts/conflict-capture.bat',
];

let missing = 0;
for (const entry of requiredEntries) {
    if (!entries.includes(entry)) {
        console.error(`Missing required entry: ${entry}`);
        missing++;
    } else {
        console.log(`Verified: ${entry}`);
    }
}

if (missing > 0) {
    console.error(`\nFAILED: Found ${missing} missing essential native binaries.`);
    process.exit(1);
}

console.log('\nVSIX verification successful.');
process.exit(0);
