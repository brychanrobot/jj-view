/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import svgtofont from 'svgtofont';

export interface BuildIconsOptions {
    srcDir?: string;
    outDir?: string;
    force?: boolean;
}

const REQUIRED_OUTPUT_FILES = [
    'jj-view-icons.woff',
    'jj-view-icons.woff2',
    'jj-view-icons.ttf',
    'jj-view-icons.css',
] as const;

/**
 * Computes a deterministic SHA-256 hash of all files in the icon source directory.
 */
export function computeIconsSourceHash(srcDir: string): string {
    if (!fs.existsSync(srcDir)) {
        return '';
    }

    const files = fs
        .readdirSync(srcDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();

    const hash = crypto.createHash('sha256');
    for (const filename of files) {
        const filePath = path.join(srcDir, filename);
        const content = fs.readFileSync(filePath);
        hash.update(`${filename}:${content.length}:`);
        hash.update(content);
    }

    return hash.digest('hex');
}

/**
 * Checks whether the generated icons are up-to-date with the source directory.
 */
export function areIconsUpToDate(srcDir: string, outDir: string): boolean {
    if (!fs.existsSync(outDir)) {
        return false;
    }

    for (const requiredFile of REQUIRED_OUTPUT_FILES) {
        const filePath = path.join(outDir, requiredFile);
        if (!fs.existsSync(filePath)) {
            return false;
        }
    }

    const currentHash = computeIconsSourceHash(srcDir);
    if (!currentHash) {
        return false;
    }

    const hashFilePath = path.join(outDir, 'icons.hash');
    if (!fs.existsSync(hashFilePath)) {
        return false;
    }

    const storedHash = fs.readFileSync(hashFilePath, 'utf-8').trim();
    return storedHash === currentHash;
}

/**
 * Builds custom icon fonts using svgtofont if needed.
 */
export async function buildIcons(options: BuildIconsOptions = {}): Promise<boolean> {
    const defaultSrcDir = path.join(import.meta.dirname, '../media/custom-icons-src');
    const defaultOutDir = path.join(import.meta.dirname, '../media/custom-icons');

    const srcDir = options.srcDir ?? defaultSrcDir;
    const outDir = options.outDir ?? defaultOutDir;
    const force = options.force ?? false;

    if (!force && areIconsUpToDate(srcDir, outDir)) {
        console.log('Custom icons are up to date. Skipping icon generation.');
        return false;
    }

    console.log('Building custom icons from SVG sources...');
    fs.mkdirSync(outDir, { recursive: true });

    process.env.TTF2WOFF2_VERSION = 'wasm';
    await svgtofont({
        src: srcDir,
        dist: outDir,
    });

    const sourceHash = computeIconsSourceHash(srcDir);
    fs.writeFileSync(path.join(outDir, 'icons.hash'), sourceHash, 'utf-8');
    console.log('Custom icons generation complete.');

    return true;
}

async function main(): Promise<void> {
    const force = process.argv.includes('--force');
    try {
        await buildIcons({ force });
    } catch (error) {
        console.error(`Failed to build custom icons: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

if (import.meta.main) {
    void main();
}
