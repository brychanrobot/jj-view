/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ParsedRelease {
    version: string;
    body: string;
}

export function parseLatestReleaseFromChangelog(content: string): ParsedRelease {
    const lines = content.split('\n');
    let version: string | undefined;
    const bodyLines: string[] = [];
    let capturing = false;

    for (const line of lines) {
        const match = /^##\s+v?([0-9]+\.[0-9]+\.[0-9]+.*)$/.exec(line.trim());
        if (match) {
            if (capturing) {
                break;
            }
            version = match[1];
            capturing = true;
            continue;
        }

        if (capturing) {
            bodyLines.push(line);
        }
    }

    if (!version) {
        throw new Error('Could not find any release section (e.g. "## 2.8.0") in CHANGELOG.md');
    }

    const body = bodyLines.join('\n').trim();
    if (!body) {
        throw new Error(`Release section "## ${version}" in CHANGELOG.md has an empty body`);
    }

    return { version, body };
}

export function encodeReleaseNotes(content: string): string {
    if (!content) {
        return '';
    }
    let encoded = encodeURIComponent(content);
    // Encode parentheses to prevent Markdown link [text](url) syntax from terminating early
    encoded = encoded.replace(/\(/g, '%28').replace(/\)/g, '%29');
    return encoded;
}

export function buildGitHubReleaseUrl(repoUrl: string, version: string, notes: string): string {
    const normalizedRepo = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '');
    const cleanVersion = version.startsWith('v') ? version.slice(1) : version;
    const tag = `v${cleanVersion}`;
    const encodedBody = encodeReleaseNotes(notes);
    return `${normalizedRepo}/releases/new?tag=${encodeURIComponent(tag)}&title=${encodeURIComponent(tag)}&body=${encodedBody}`;
}

interface OpenCommand {
    command: string;
    args: string[];
}

function getPlatformOpener(target: string): OpenCommand {
    if (process.platform === 'darwin') {
        return { command: 'open', args: [target] };
    }
    if (process.platform === 'win32') {
        return { command: 'cmd.exe', args: ['/c', 'start', '""', `"${target}"`] };
    }
    if (process.env.WSL_DISTRO_NAME && !fs.existsSync('/usr/bin/xdg-open') && fs.existsSync('/usr/bin/wslview')) {
        return { command: 'wslview', args: [target] };
    }
    return { command: 'xdg-open', args: [target] };
}

export async function openInBrowser(url: string): Promise<void> {
    const { command, args } = getPlatformOpener(url);

    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' });
        child.on('error', (err) => {
            reject(new Error(`Failed to spawn ${command}: ${err.message}`));
        });
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} exited with code ${code}, signal ${signal}`));
        });
    });
}

function findProjectRoot(): string {
    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, 'CHANGELOG.md')) && fs.existsSync(path.join(cwd, 'package.json'))) {
        return cwd;
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const parentRoot = path.resolve(currentDir, '..');
    if (fs.existsSync(path.join(parentRoot, 'CHANGELOG.md')) && fs.existsSync(path.join(parentRoot, 'package.json'))) {
        return parentRoot;
    }
    return cwd;
}

function getRepoUrl(root: string): string {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        return 'https://github.com/brychanrobot/jj-view';
    }
    try {
        const pkgContent = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(pkgContent) as { repository?: { url?: string } | string };
        if (typeof pkg.repository === 'string') {
            return pkg.repository;
        }
        if (pkg.repository?.url) {
            return pkg.repository.url;
        }
    } catch {
        // Fall back to default repo URL
    }
    return 'https://github.com/brychanrobot/jj-view';
}

async function run(): Promise<void> {
    const rawArgs = process.argv.slice(2);
    const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`Usage: pnpm release:open [options] [url]

Opens the GitHub release creation page in your default browser without chat URL truncation.

Options:
  --dry-run, -n    Print the constructed URL without opening the browser
  --help, -h       Show this help message

If [url] is omitted, the script automatically parses the latest release section from
CHANGELOG.md, crafts the GitHub release creation URL, and launches the browser.
`);
        return;
    }

    const dryRun = args.includes('--dry-run') || args.includes('-n');
    const filteredArgs = args.filter((arg) => arg !== '--dry-run' && arg !== '-n');

    let releaseUrl: string;

    const directUrl = filteredArgs.find((arg) => arg.startsWith('http://') || arg.startsWith('https://'));
    if (directUrl) {
        try {
            new URL(directUrl);
            releaseUrl = directUrl;
        } catch {
            throw new Error(`Invalid URL provided: ${directUrl}`);
        }
    } else {
        const root = findProjectRoot();
        const changelogPath = path.join(root, 'CHANGELOG.md');
        if (!fs.existsSync(changelogPath)) {
            throw new Error(`CHANGELOG.md not found at ${changelogPath}`);
        }

        const changelogContent = fs.readFileSync(changelogPath, 'utf8');
        const { version, body } = parseLatestReleaseFromChangelog(changelogContent);
        const repoUrl = getRepoUrl(root);

        releaseUrl = buildGitHubReleaseUrl(repoUrl, version, body);
        console.log(`Parsed release v${version} from CHANGELOG.md`);
    }

    console.log(`Release URL: ${releaseUrl}`);

    if (dryRun) {
        console.log('Dry run enabled; skipping browser launch.');
        return;
    }

    console.log('Launching browser to create release...');
    await openInBrowser(releaseUrl);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
    run().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
    });
}
