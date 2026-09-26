/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function ensurePrerequisites(): void {
    console.log('[dev] Running asset generation prerequisites...');

    // 1. Generate themes
    cp.execFileSync(process.execPath, [path.join(rootDir, 'tooling/generate-themes.ts')], {
        stdio: 'inherit',
    });

    // 2. Generate settings schema
    cp.execFileSync(process.execPath, [path.join(rootDir, 'tooling/generate-settings-schema.ts')], {
        stdio: 'inherit',
    });

    // 3. Build custom icons
    cp.execFileSync(process.execPath, [path.join(rootDir, 'tooling/build-icons.ts')], {
        stdio: 'inherit',
    });

    // 4. Copy static icons to web/dist
    const assets = [
        {
            src: 'node_modules/@vscode/codicons/dist/codicon.css',
            dest: 'web/dist/codicons/codicon.css',
        },
        {
            src: 'node_modules/@vscode/codicons/dist/codicon.ttf',
            dest: 'web/dist/codicons/codicon.ttf',
        },
        {
            src: 'media/custom-icons/jj-view-icons.css',
            dest: 'web/dist/custom-icons/jj-view-icons.css',
        },
        {
            src: 'media/custom-icons/jj-view-icons.woff2',
            dest: 'web/dist/custom-icons/jj-view-icons.woff2',
        },
    ];

    for (const asset of assets) {
        const srcPath = path.join(rootDir, asset.src);
        const destPath = path.join(rootDir, asset.dest);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function ensureGoBinary(): string {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'jj-view.exe' : 'jj-view';
    const binaryPath = path.join(rootDir, 'dist/bin', binaryName);

    if (!fs.existsSync(binaryPath)) {
        console.error(
            `[dev] Error: JJ View Go binary not found at ${binaryPath}.\n` +
                'Please run "pnpm build:server" before starting the dev server.',
        );
        process.exit(1);
    }

    return binaryPath;
}

function openBrowser(targetUrl: string): void {
    if (process.env.NO_OPEN || process.argv.includes('--no-open')) {
        return;
    }
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    try {
        if (isWin) {
            cp.spawn('cmd', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' });
        } else if (isMac) {
            cp.spawn('open', [targetUrl], { detached: true, stdio: 'ignore' });
        } else {
            cp.spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' });
        }
    } catch (err) {
        console.warn('[dev] Could not automatically open browser:', err);
    }
}

async function main(): Promise<void> {
    ensurePrerequisites();
    const binaryPath = ensureGoBinary();

    console.log('[dev] Starting JJ View Go daemon...');
    const goProc = cp.spawn(binaryPath, ['-host', '127.0.0.1', '-port', '0', '-repo', '.', '-no-open'], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let goPort = 0;
    let sessionToken = '';

    await new Promise<void>((resolve, reject) => {
        const timeoutTimer = setTimeout(() => {
            reject(new Error('Timed out waiting for Go daemon startup after 15s.'));
        }, 15000);

        goProc.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8');
            const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/);
            if (match) {
                clearTimeout(timeoutTimer);
                goPort = Number.parseInt(match[1], 10);
                sessionToken = match[2];
                resolve();
            }
        });

        goProc.stderr?.on('data', (chunk: Buffer) => {
            process.stderr.write(chunk);
        });

        goProc.on('error', (err) => {
            clearTimeout(timeoutTimer);
            reject(err);
        });

        goProc.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                clearTimeout(timeoutTimer);
                reject(new Error(`Go daemon exited with code ${code}`));
            }
        });
    });

    console.log(`[dev] Go daemon active on port ${goPort}. Starting Vite dev server with HMR...`);

    process.env.JJ_VIEW_BACKEND_PORT = String(goPort);

    const viteServer = await createServer({
        configFile: path.join(rootDir, 'web/vite.config.ts'),
    });

    await viteServer.listen();
    viteServer.printUrls();

    const address = viteServer.httpServer?.address();
    const port = typeof address === 'object' && address ? address.port : 5173;
    const devUrl = `http://127.0.0.1:${port}/?token=${sessionToken}`;

    console.log('\n========================================================================');
    console.log('  JJ View Dev Server Active (True In-Place HMR)');
    console.log(`\n  App URL:   ${devUrl}`);
    console.log(`  Backend:   http://127.0.0.1:${goPort}`);
    console.log('\n  Hot Module Replacement is active:');
    console.log('  - Edits to Svelte component styles update in-place in ~10ms');
    console.log('  - Edits to Svelte markup and logic update live in the DOM');
    console.log('  - Input state, open diffs, and WebSocket stay connected');
    console.log('\n  Press Ctrl+C to stop.');
    console.log('========================================================================\n');

    openBrowser(devUrl);

    let isCleaningUp = false;
    const cleanup = async (): Promise<void> => {
        if (isCleaningUp) {
            return;
        }
        isCleaningUp = true;
        console.log('\n[dev] Shutting down dev server and daemon...');

        try {
            await viteServer.close();
        } catch (_) {}

        try {
            goProc.kill('SIGTERM');
        } catch (_) {}

        process.exit(0);
    };

    process.on('SIGINT', () => {
        void cleanup();
    });
    process.on('SIGTERM', () => {
        void cleanup();
    });
    goProc.on('exit', () => {
        void cleanup();
    });
}

main().catch((err) => {
    console.error('[dev] Failed to start dev server:', err);
    process.exit(1);
});
