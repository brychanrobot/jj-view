/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SetupSidecarOptions {
    workspaceRoot?: string;
    globalConfigDir?: string;
}

export function setupSidecar(options?: SetupSidecarOptions): void {
    const rootDir = options?.workspaceRoot ?? path.resolve(__dirname, '..');
    const binName = process.platform === 'win32' ? 'jj-view.exe' : 'jj-view';
    const binPath = path.join(rootDir, 'dist', 'bin', binName);

    if (!fs.existsSync(binPath)) {
        console.info(`[Setup Sidecar] Binary not found at dist/bin/${binName}. Compiling...`);
        execSync(`go build -o dist/bin/${binName} ./cmd/jj-view`, {
            cwd: rootDir,
            stdio: 'inherit',
        });
    }

    if (!fs.existsSync(binPath)) {
        throw new Error(`Failed to locate compiled binary at: ${binPath}`);
    }

    const homeDir = os.homedir();
    const configDir = options?.globalConfigDir ?? path.join(homeDir, '.gemini', 'config');
    const sidecarDir = path.join(configDir, 'sidecars', 'jj-view');

    if (!fs.existsSync(sidecarDir)) {
        fs.mkdirSync(sidecarDir, { recursive: true });
    }

    const manifestPath = path.join(sidecarDir, 'sidecar.json');
    const manifest = {
        description: 'JJ View Jujutsu (jj) visual interface.',
        display_name: 'JJ View',
        command: binPath,
        args: ['-host', '127.0.0.1', '-port', '{{.port}}', '-no-open'],
        restart_policy: 'always',
        has_web_ui: true,
        ui_config: {
            display_name: 'JJ View',
            views: [
                {
                    entrypoint: 'SIDECAR_UI_ENTRYPOINT_FULL_PANE',
                    path: '/',
                    title: 'JJ View Graph',
                },
                {
                    entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
                    path: '/',
                    title: 'JJ SCM',
                },
            ],
        },
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.info(`[Setup Sidecar] Installed sidecar manifest at: ${manifestPath}`);

    // Update config.json to enable jj-view sidecar
    const configPath = path.join(configDir, 'config.json');
    let configData: Record<string, unknown> = {};

    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            configData = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
            console.warn('[Setup Sidecar] Failed to parse existing config.json. Backing up to config.json.bak:', err);
            try {
                fs.copyFileSync(configPath, `${configPath}.bak`);
            } catch {
                // Ignore backup error
            }
        }
    }

    const sidecars = (configData.sidecars as Record<string, unknown> | undefined) ?? {};
    sidecars['jj-view'] = {
        enabled: true,
        all_projects: true,
    };
    configData.sidecars = sidecars;

    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf-8');
    console.info(`[Setup Sidecar] Enabled 'jj-view' sidecar in: ${configPath}`);
    console.info(
        '[Setup Sidecar] Sidecar setup complete! JJ View will appear in Antigravity Auxiliary and Full Panes.',
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    setupSidecar();
}
