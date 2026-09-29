/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildTarget {
    readonly os: string;
    readonly arch: string;
    readonly ext: string;
}

export const TARGETS: readonly BuildTarget[] = [
    { os: 'linux', arch: 'amd64', ext: '' },
    { os: 'linux', arch: 'arm64', ext: '' },
    { os: 'darwin', arch: 'amd64', ext: '' },
    { os: 'darwin', arch: 'arm64', ext: '' },
    { os: 'windows', arch: 'amd64', ext: '.exe' },
    { os: 'windows', arch: 'arm64', ext: '.exe' },
];

function buildWebAssets(rootDir: string): void {
    console.log('[build-web-binaries] Building production web assets...');
    cp.execSync('node esbuild.js --web --production', {
        cwd: rootDir,
        stdio: 'inherit',
        env: process.env,
    });
}

function getPackageVersion(rootDir: string): string {
    const pkgPath = path.join(rootDir, 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    if (!pkg.version) {
        throw new Error('Could not find version in package.json');
    }
    return pkg.version;
}

function computeSha256(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function buildTarget(
    rootDir: string,
    releaseDir: string,
    target: BuildTarget,
    version: string,
): { binaryName: string; checksum: string } {
    const binaryName = `jj-view-web-${target.os}-${target.arch}${target.ext}`;
    const binaryPath = path.join(releaseDir, binaryName);

    console.log(`[build-web-binaries] Compiling ${binaryName}...`);
    cp.execSync(`go build -ldflags "-s -w -X main.version=${version}" -o ${JSON.stringify(binaryPath)} ./cmd/jj-view`, {
        cwd: rootDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            CGO_ENABLED: '0',
            GOOS: target.os,
            GOARCH: target.arch,
        },
    });

    fs.chmodSync(binaryPath, 0o755);

    const checksum = computeSha256(binaryPath);
    return { binaryName, checksum };
}

export function buildAllWebBinaries(): void {
    const currentFile = fileURLToPath(import.meta.url);
    const rootDir = path.resolve(path.dirname(currentFile), '..');
    const releaseDir = path.join(rootDir, 'dist', 'release');

    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.mkdirSync(releaseDir, { recursive: true });

    buildWebAssets(rootDir);

    const version = getPackageVersion(rootDir);
    console.log(`[build-web-binaries] Target version: ${version}`);

    const results: Array<{ binaryName: string; checksum: string }> = [];

    for (const target of TARGETS) {
        const result = buildTarget(rootDir, releaseDir, target, version);
        results.push(result);
    }

    const checksumFile = path.join(releaseDir, 'checksums.txt');
    const checksumContent = `${results.map((r) => `${r.checksum}  ${r.binaryName}`).join('\n')}\n`;
    fs.writeFileSync(checksumFile, checksumContent, 'utf-8');

    // Ensure dist/bin/jj-view exists for host execution (e.g. tests or local dev)
    const hostBinaryName = process.platform === 'win32' ? 'jj-view.exe' : 'jj-view';
    const hostArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const hostOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const matchingBinary = path.join(
        releaseDir,
        `jj-view-web-${hostOs}-${hostArch}${hostOs === 'windows' ? '.exe' : ''}`,
    );
    const binDir = path.join(rootDir, 'dist', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    if (fs.existsSync(matchingBinary)) {
        const targetPath = path.join(binDir, hostBinaryName);
        fs.copyFileSync(matchingBinary, targetPath);
        fs.chmodSync(targetPath, 0o755);
    }

    console.log('\n[build-web-binaries] Successfully built all standalone web binaries:');
    for (const r of results) {
        const binaryPath = path.join(releaseDir, r.binaryName);
        const stats = fs.statSync(binaryPath);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`  - ${r.binaryName} (${sizeMb} MB) [SHA256: ${r.checksum}]`);
    }
    console.log(`  - checksums.txt`);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
    try {
        buildAllWebBinaries();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[build-web-binaries] Build failed: ${message}`);
        process.exit(1);
    }
}
