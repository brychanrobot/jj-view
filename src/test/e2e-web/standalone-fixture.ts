/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test as baseTest, expect, type Page } from '@playwright/test';
import type { HostEnvironment } from '../../core/host/host-environment';
import { TestRepo } from '../test-repo';

export { expect, type Page };

export const ARTIFACT_DIR = process.env.ARTIFACTS_DIR
    ? path.resolve(process.env.ARTIFACTS_DIR)
    : path.resolve(__dirname, '../../../test-artifacts');

if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

declare global {
    interface Window {
        __JJ_VIEW_ENV__?: HostEnvironment & {
            notifications: {
                setPosition(position: string): void;
            };
        };
        __JJ_VIEW_REPO_MANAGER__?: {
            readonly repositories: readonly {
                readonly rootUri: { readonly fsPath: string };
            }[];
        };
    }
}
export class StandaloneServer {
    public serverUrl = '';
    public baseUrl = '';
    public port = 0;
    public sessionToken = '';
    public userDataDir = '';

    private _process: cp.ChildProcess | null = null;
    private _stdout = '';
    private _stderr = '';

    constructor(public readonly repo: TestRepo) {}

    public async start(): Promise<void> {
        const isWin = process.platform === 'win32';
        const binaryName = isWin ? 'jj-view.exe' : 'jj-view';
        const binaryPath = path.resolve(__dirname, '../../../dist/bin', binaryName);

        if (!fs.existsSync(binaryPath)) {
            throw new Error(`jj-view binary not found at ${binaryPath}. Did you run 'pnpm build:all'?`);
        }

        const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-e2e-userdata-'));
        this.userDataDir = tempUserDataDir;

        return new Promise<void>((resolve, reject) => {
            const proc = cp.spawn(
                binaryPath,
                [
                    '-host',
                    '127.0.0.1',
                    '-port',
                    '0',
                    '-repo',
                    this.repo.path,
                    '-user-data-dir',
                    tempUserDataDir,
                    '-no-open',
                ],
                {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: {
                        ...process.env,
                        XDG_CONFIG_HOME: tempUserDataDir,
                        XDG_STATE_HOME: tempUserDataDir,
                        APPDATA: tempUserDataDir,
                        LOCALAPPDATA: tempUserDataDir,
                        HOME: tempUserDataDir,
                    },
                },
            );

            this._process = proc;

            const timeoutTimer = setTimeout(() => {
                proc.kill('SIGTERM');
                reject(new Error(`Timed out waiting for jj-view server startup after 15s.\nStderr: ${this._stderr}`));
            }, 15000);

            proc.stderr?.on('data', (chunk: Buffer) => {
                this._stderr += chunk.toString('utf-8');
            });

            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf-8');
                this._stdout += text;
                const match = this._stdout.match(/http:\/\/(127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+))/);
                if (match) {
                    clearTimeout(timeoutTimer);
                    this.serverUrl = `http://${match[1]}`;
                    this.port = Number.parseInt(match[2], 10);
                    this.sessionToken = match[3];
                    this.baseUrl = `http://127.0.0.1:${this.port}`;
                    resolve();
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timeoutTimer);
                reject(err);
            });

            proc.on('exit', (code) => {
                clearTimeout(timeoutTimer);
                if (!this.serverUrl) {
                    reject(
                        new Error(
                            `jj-view server exited prematurely with code ${code}.\nStdout: ${this._stdout}\nStderr: ${this._stderr}`,
                        ),
                    );
                }
            });
        });
    }

    public async stop(): Promise<void> {
        const proc = this._process;
        if (!proc) {
            return;
        }

        if (proc.exitCode !== null || proc.killed) {
            this._process = null;
            if (this.userDataDir) {
                try {
                    fs.rmSync(this.userDataDir, { recursive: true, force: true });
                } catch {
                    // Ignore cleanup error
                }
                this.userDataDir = '';
            }
            return;
        }

        return new Promise<void>((resolve) => {
            let resolved = false;
            const complete = () => {
                if (!resolved) {
                    resolved = true;
                    this._process = null;
                    if (this.userDataDir) {
                        try {
                            fs.rmSync(this.userDataDir, { recursive: true, force: true });
                        } catch {
                            // Ignore cleanup error
                        }
                        this.userDataDir = '';
                    }
                    resolve();
                }
            };

            const forceKillTimer = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // Ignore kill failure
                }
                complete();
            }, 3000);

            proc.on('exit', () => {
                clearTimeout(forceKillTimer);
                complete();
            });

            try {
                proc.kill('SIGTERM');
            } catch {
                clearTimeout(forceKillTimer);
                complete();
            }
        });
    }
}

export const test = baseTest.extend<{
    testRepo: TestRepo;
    server: StandaloneServer;
}>({
    testRepo: async ({ playwright: _unused }, use) => {
        const repo = new TestRepo();
        try {
            repo.init();
            await use(repo);
        } finally {
            await repo.dispose();
        }
    },
    server: async ({ testRepo }, use) => {
        const server = new StandaloneServer(testRepo);
        try {
            await server.start();
            await use(server);
        } finally {
            await server.stop();
        }
    },
    page: async ({ page }, use, testInfo) => {
        await use(page);

        // Automatic Failure Diagnostics (Screenshots & DOM Dumps)
        const hasFailed =
            (testInfo.status && testInfo.status !== 'passed' && testInfo.status !== 'skipped') ||
            testInfo.errors.length > 0;

        if (hasFailed) {
            try {
                const artifactDir = path.join(testInfo.outputDir, Math.random().toString(36).substring(2, 10));
                fs.mkdirSync(artifactDir, { recursive: true });
                const pngPath = path.join(artifactDir, 'test-failure.png');
                const htmlPath = path.join(artifactDir, 'test-failure.html');

                await page.screenshot({ path: pngPath, timeout: 5000 });
                const html = await page.content();
                fs.writeFileSync(htmlPath, html, 'utf-8');

                await testInfo.attach('test-failure.png', {
                    path: pngPath,
                    contentType: 'image/png',
                });
                await testInfo.attach('test-failure.html', {
                    path: htmlPath,
                    contentType: 'text/html',
                });
            } catch (err) {
                console.error('Failed to capture failure artifacts:', err);
            }
        }
    },
});

export async function waitForScmReady(page: Page): Promise<void> {
    await expect(page.locator('[data-testid="scm-pane"]')).toBeVisible({ timeout: 15000 });
}

export interface RecordGifOptions {
    outputPath: string;
    framerate?: number; // default 1.2 fps
    scale?: number; // default 960px width
}

/**
 * Executes a user interaction flow, capturing designated keyframes and
 * encoding them into an optimized animated GIF using ffmpeg two-pass palette generation.
 */
export async function recordGifFlow(
    page: Page,
    actionFlow: (captureFrame: () => Promise<void>) => Promise<void>,
    options: RecordGifOptions,
): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-gif-'));
    let frameIndex = 0;

    const captureFrame = async (): Promise<void> => {
        const framePath = path.join(tempDir, `frame-${frameIndex++}.png`);
        await page.screenshot({ path: framePath });
    };

    try {
        await actionFlow(captureFrame);

        if (frameIndex > 0) {
            fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
            const framerate = options.framerate ?? 1.2;
            const scale = options.scale ?? 960;
            const ffmpegCmd = [
                'ffmpeg -y',
                `-framerate ${framerate} -i "${tempDir}/frame-%d.png"`,
                `-vf "fps=10,scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"`,
                `"${options.outputPath}"`,
            ].join(' ');

            try {
                cp.execSync(ffmpegCmd, { stdio: 'pipe' });
            } catch (err: unknown) {
                console.warn(
                    `[recordGifFlow] ffmpeg encoding skipped or failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
