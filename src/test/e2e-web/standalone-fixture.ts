/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test as baseTest, expect, type Locator, type Page } from '@playwright/test';
import type { HostEnvironment } from '../../core/host/host-environment';
import { TestRepo } from '../test-repo';

export { expect, type Locator, type Page };

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
                refresh(options?: { forceSnapshot?: boolean; reason?: string }): Promise<void>;
            }[];
        };
    }
}
export interface StandaloneServerOptions {
    /**
     * Seeds the daemon's user data directory before launch. The daemon runs
     * with HOME pointed at this directory, so tests can plant files like
     * `.gitcookies` or `config.json` (user settings) here.
     */
    readonly prepareUserData?: (userDataDir: string) => void;
}

export class StandaloneServer {
    public serverUrl = '';
    public baseUrl = '';
    public port = 0;
    public sessionToken = '';
    public userDataDir = '';
    public serverTmpDir = '';

    private _process: cp.ChildProcess | null = null;
    private _stdout = '';
    private _stderr = '';
    private _spawnErrored = false;
    private _stopPromise: Promise<void> | null = null;

    constructor(
        public readonly repo: TestRepo,
        private readonly options: StandaloneServerOptions = {},
    ) {}

    private cleanupTempDirs(): void {
        for (const dir of [this.userDataDir, this.serverTmpDir]) {
            if (dir) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
                } catch {
                    // Ignore cleanup error
                }
            }
        }
        this.userDataDir = '';
        this.serverTmpDir = '';
    }

    public async start(): Promise<void> {
        const isWin = process.platform === 'win32';
        const binaryName = isWin ? 'jj-view.exe' : 'jj-view';
        const binaryPath = path.resolve(__dirname, '../../../dist/bin', binaryName);

        if (!fs.existsSync(binaryPath)) {
            throw new Error(`jj-view binary not found at ${binaryPath}. Did you run 'pnpm build:all'?`);
        }

        if (this.userDataDir || this.serverTmpDir) {
            this.cleanupTempDirs();
        }

        const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-e2e-userdata-'));
        const tempServerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-e2e-tmp-'));
        this.userDataDir = tempUserDataDir;
        this.serverTmpDir = tempServerTmpDir;
        this._spawnErrored = false;
        this._stopPromise = null;

        let proc: cp.ChildProcess;
        try {
            this.options.prepareUserData?.(tempUserDataDir);
            proc = cp.spawn(
                binaryPath,
                [
                    '--host',
                    '127.0.0.1',
                    '--port',
                    '0',
                    '--repo',
                    this.repo.path,
                    '--user-data-dir',
                    tempUserDataDir,
                    '--no-open',
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
                        TMPDIR: tempServerTmpDir,
                        TEMP: tempServerTmpDir,
                        TMP: tempServerTmpDir,
                    },
                },
            );
        } catch (err) {
            this.cleanupTempDirs();
            throw err;
        }

        this._process = proc;

        return new Promise<void>((resolve, reject) => {
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
                this._spawnErrored = true;
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
        if (this._stopPromise) {
            return this._stopPromise;
        }

        const proc = this._process;
        if (!proc) {
            this.cleanupTempDirs();
            return;
        }

        if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined || this._spawnErrored) {
            this._process = null;
            this.cleanupTempDirs();
            return;
        }

        this._stopPromise = new Promise<void>((resolve) => {
            let resolved = false;
            const complete = () => {
                if (!resolved) {
                    resolved = true;
                    this._process = null;
                    this.cleanupTempDirs();
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

        return this._stopPromise;
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
    await expect(page.locator('[data-testid="scm-pane"]')).toBeVisible({
        timeout: 15000,
    });
}

export const isMac = process.platform === 'darwin';

/** Helper to trigger Save across platforms (Meta+s on Mac, Control+s otherwise) */
export async function save(page: Page): Promise<void> {
    await page.keyboard.press(isMac ? 'Meta+s' : 'Control+s');
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
            const outFps = Math.max(10, Math.min(24, Math.round(framerate)));
            const scale = options.scale ?? 960;
            const vfArg = `fps=${outFps},scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;

            try {
                cp.execFileSync(
                    'ffmpeg',
                    [
                        '-y',
                        '-framerate',
                        String(framerate),
                        '-i',
                        path.join(tempDir, 'frame-%d.png'),
                        '-vf',
                        vfArg,
                        options.outputPath,
                    ],
                    { stdio: 'ignore' },
                );
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

export interface RecordInteractionOptions {
    gifPath: string;
    mp4Path?: string;
    fps?: number; // default 24
    scale?: number; // default 1280
}

/**
 * High-speed 24fps interaction recorder that simulates smooth mouse paths,
 * hover pauses, visual press rings, drag peeling gestures, and HUD titles.
 */
export class InteractionRecorder {
    private frameIndex = 0;
    private cursorX = 720;
    private cursorY = 200;

    constructor(
        private readonly page: Page,
        private readonly tempDir: string,
    ) {}

    get frameCount(): number {
        return this.frameIndex;
    }

    async captureFrame(): Promise<void> {
        this.frameIndex++;
        const filename = `frame_${String(this.frameIndex).padStart(5, '0')}.png`;
        await this.page.screenshot({ path: path.join(this.tempDir, filename) });
    }

    async setHud(text: string): Promise<void> {
        await this.page.evaluate((t: string) => {
            const el = document.getElementById('jj-hud-text');
            if (el) {
                el.textContent = t;
            }
        }, text);
    }

    async setCursorPos(x: number, y: number): Promise<void> {
        this.cursorX = x;
        this.cursorY = y;
        await this.page.evaluate(
            ({ cx, cy }: { cx: number; cy: number }) => {
                const cur = document.getElementById('jj-virtual-cursor');
                if (cur) {
                    cur.style.transform = `translate(${cx}px, ${cy}px)`;
                }
            },
            { cx: x, cy: y },
        );
        await this.page.mouse.move(x, y);
    }

    async moveTo(target: Locator, frames = 24): Promise<void> {
        const resolved: { box: { x: number; y: number; width: number; height: number } | null } = { box: null };
        await expect(async () => {
            await target.waitFor({ state: 'visible', timeout: 2000 });
            await target.scrollIntoViewIfNeeded({ timeout: 2000 });
            const box = await target.boundingBox();
            if (!box) {
                throw new Error('InteractionRecorder.moveTo: target locator has no boundingBox');
            }
            resolved.box = box;
        }).toPass({ timeout: 10000 });
        if (!resolved.box) {
            throw new Error('InteractionRecorder.moveTo: target locator has no boundingBox');
        }
        await this.moveToPoint(
            resolved.box.x + resolved.box.width / 2,
            resolved.box.y + resolved.box.height / 2,
            frames,
        );
    }

    async moveToPoint(x: number, y: number, frames = 24): Promise<void> {
        const startX = this.cursorX;
        const startY = this.cursorY;
        const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
        const totalFrames = Math.max(1, frames);

        for (let f = 1; f <= totalFrames; f++) {
            const u = ease(f / totalFrames);
            await this.setCursorPos(startX + (x - startX) * u, startY + (y - startY) * u);
            await this.captureFrame();
        }
    }

    async hover(frames = 12): Promise<void> {
        for (let f = 0; f < frames; f++) {
            await this.captureFrame();
        }
    }

    async click(target: Locator, holdFrames = 4): Promise<void> {
        await this.moveTo(target, 16);
        try {
            await this.page.evaluate(() => {
                const r = document.getElementById('jj-cursor-ring');
                if (r) {
                    r.style.transform = 'translate(-50%,-50%) scale(1)';
                    r.style.opacity = '1';
                    r.style.background = 'color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent)';
                }
            });
            for (let f = 0; f < holdFrames; f++) {
                await this.captureFrame();
            }
            await expect(async () => {
                await target.click({ force: true, timeout: 2000 });
            }).toPass({ timeout: 5000 });
        } finally {
            try {
                await this.page.evaluate(() => {
                    const r = document.getElementById('jj-cursor-ring');
                    if (r) {
                        r.style.transform = 'translate(-50%,-50%) scale(0)';
                        r.style.opacity = '0';
                        r.style.background = 'transparent';
                    }
                });
                await this.captureFrame();
            } catch {
                // Page may have closed
            }
        }
    }

    async dragBy(
        target: Locator,
        deltaY: number,
        dragFrames = 42,
        holdStartFrames = 5,
        holdEndFrames = 6,
    ): Promise<void> {
        await this.moveTo(target, 16);
        await this.hover(holdStartFrames);

        try {
            await this.page.evaluate(() => {
                const r = document.getElementById('jj-cursor-ring');
                if (r) {
                    r.style.transform = 'translate(-50%,-50%) scale(1)';
                    r.style.opacity = '1';
                    r.style.background = 'color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent)';
                }
            });
            await this.page.mouse.down();
            await this.captureFrame();

            const startX = this.cursorX;
            const startY = this.cursorY;
            const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
            const totalFrames = Math.max(1, dragFrames);

            for (let f = 1; f <= totalFrames; f++) {
                const u = ease(f / totalFrames);
                await this.setCursorPos(startX, startY + deltaY * u);
                await this.captureFrame();
            }

            await this.hover(holdEndFrames);
        } finally {
            try {
                await this.page.mouse.up();
                await this.page.evaluate(() => {
                    const r = document.getElementById('jj-cursor-ring');
                    if (r) {
                        r.style.transform = 'translate(-50%,-50%) scale(0)';
                        r.style.opacity = '0';
                        r.style.background = 'transparent';
                    }
                });
                await this.captureFrame();
            } catch {
                // Page may have closed
            }
        }
    }
}

/**
 * Automates 24fps interaction recordings with virtual cursor animations,
 * HUD telemetry pills, and two-pass ffmpeg GIF/MP4 encoding.
 */
export async function recordInteractionFlow(
    page: Page,
    options: RecordInteractionOptions,
    flow: (rec: InteractionRecorder) => Promise<void>,
): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-interaction-flow-'));
    const rec = new InteractionRecorder(page, tempDir);

    try {
        await page.evaluate(() => {
            document.getElementById('jj-virtual-cursor')?.remove();
            document.getElementById('jj-interaction-hud')?.remove();

            const cur = document.createElement('div');
            cur.id = 'jj-virtual-cursor';
            cur.style.cssText =
                'position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:2147483647;transform:translate(720px,200px);';
            cur.innerHTML =
                '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="filter:drop-shadow(0 2px 5px rgba(0,0,0,0.85));position:absolute;top:0;left:0;pointer-events:none;"><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.86a.5.5 0 0 0-.85.35z" fill="#ffffff" stroke="#111116" stroke-width="1.5" stroke-linejoin="round"/></svg><div id="jj-cursor-ring" style="position:absolute;top:0;left:0;width:32px;height:32px;border-radius:50%;border:2px solid var(--vscode-focusBorder);box-sizing:border-box;transform:translate(-50%,-50%) scale(0);opacity:0;pointer-events:none;"></div>';
            document.body.appendChild(cur);

            const hud = document.createElement('div');
            hud.id = 'jj-interaction-hud';
            hud.style.cssText =
                'position:fixed;bottom:24px;right:24px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-input-border);backdrop-filter:blur(8px);color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family, monospace);font-size:12px;font-weight:500;padding:10px 18px;border-radius:6px;box-shadow:0 4px 18px color-mix(in srgb, var(--vscode-widget-shadow, var(--vscode-foreground)) 28%, transparent);pointer-events:none;z-index:2147483647;display:flex;align-items:center;gap:10px;';
            hud.innerHTML =
                '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--vscode-focusBorder);box-shadow:0 0 8px var(--vscode-focusBorder);"></span><span id="jj-hud-text">JJ View</span>';
            document.body.appendChild(hud);
        });

        await flow(rec);

        if (rec.frameCount > 0) {
            fs.mkdirSync(path.dirname(options.gifPath), { recursive: true });
            const fps = options.fps ?? 24;
            const scale = options.scale ?? 1280;
            const vfGif = `fps=${fps},scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;

            try {
                cp.execFileSync(
                    'ffmpeg',
                    [
                        '-y',
                        '-framerate',
                        String(fps),
                        '-i',
                        path.join(tempDir, 'frame_%05d.png'),
                        '-vf',
                        vfGif,
                        options.gifPath,
                    ],
                    { stdio: 'ignore' },
                );
            } catch (err: unknown) {
                console.warn(
                    `[recordInteractionFlow] ffmpeg GIF encoding failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            if (options.mp4Path) {
                fs.mkdirSync(path.dirname(options.mp4Path), { recursive: true });
                const vfMp4 = `fps=${fps},scale=${scale}:-2:flags=lanczos`;
                try {
                    cp.execFileSync(
                        'ffmpeg',
                        [
                            '-y',
                            '-framerate',
                            String(fps),
                            '-i',
                            path.join(tempDir, 'frame_%05d.png'),
                            '-vf',
                            vfMp4,
                            '-c:v',
                            'libx264',
                            '-pix_fmt',
                            'yuv420p',
                            '-crf',
                            '19',
                            '-movflags',
                            '+faststart',
                            options.mp4Path,
                        ],
                        { stdio: 'ignore' },
                    );
                } catch (err: unknown) {
                    console.warn(
                        `[recordInteractionFlow] ffmpeg MP4 encoding failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
        }
    } finally {
        try {
            await page.evaluate(() => {
                document.getElementById('jj-virtual-cursor')?.remove();
                document.getElementById('jj-interaction-hud')?.remove();
            });
        } catch {
            // Page may have closed
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
