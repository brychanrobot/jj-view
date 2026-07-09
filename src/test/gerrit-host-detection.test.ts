/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { detectGerritHost, normalizeHostUrl, parseRemoteUrl } from '../utils/gerrit-host-detection';
import { createMock } from './test-utils';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: vi.fn(() => ({
            get: vi.fn(),
        })),
    },
}));

function mockGerritHostSetting(value: string | undefined): void {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(
        createMock<vscode.WorkspaceConfiguration>({
            get: (key: string) => {
                if (key === 'gerrit.host') {
                    return value;
                }
                return undefined;
            },
        }),
    );
}

describe('Gerrit Host Detection Utilities', () => {
    describe('normalizeHostUrl', () => {
        test('prepends protocol, trims trailing slashes', () => {
            expect(normalizeHostUrl('gerrit.example.com/')).toBe('https://gerrit.example.com');
            expect(normalizeHostUrl('http://gerrit.example.com//')).toBe('http://gerrit.example.com');
        });

        test('extracts origin for googlesource.com hosts', () => {
            expect(normalizeHostUrl('https://chromium.googlesource.com/chromium/src')).toBe(
                'https://chromium.googlesource.com',
            );
        });

        test('preserves paths for non-googlesource.com hosts', () => {
            expect(normalizeHostUrl('https://git.eclipse.org/gerrit/p/platform')).toBe(
                'https://git.eclipse.org/gerrit/p/platform',
            );
        });
    });

    describe('parseRemoteUrl', () => {
        test('handles googlesource.com and /gerrit/ URLs', () => {
            expect(parseRemoteUrl('https://chromium.googlesource.com/chromium/src.git')).toBe(
                'https://chromium-review.googlesource.com',
            );
            expect(parseRemoteUrl('https://git.eclipse.org/gerrit/p/platform.git')).toBe(
                'https://git.eclipse.org/gerrit/p/platform',
            );
        });

        test('handles sso:// URLs', () => {
            expect(parseRemoteUrl('sso://chromium/chromium/src.git')).toBe('https://chromium-review.googlesource.com');
        });

        test('handles ssh:// URLs', () => {
            expect(parseRemoteUrl('ssh://user@gerrit.example.com:29418/gerrit/project')).toBe(
                'https://gerrit.example.com',
            );
        });

        test('handles persistent-https:// and rpc:// URLs', () => {
            expect(parseRemoteUrl('persistent-https://chromium.googlesource.com/chromium/src')).toBe(
                'https://chromium-review.googlesource.com',
            );
            expect(parseRemoteUrl('rpc://chromium.googlesource.com/chromium/src')).toBe(
                'https://chromium-review.googlesource.com',
            );
        });

        test('handles SCP-like ssh URLs', () => {
            expect(parseRemoteUrl('user@gerrit.example.com:gerrit/project.git')).toBe('https://gerrit.example.com');
        });

        test('returns undefined for non-Gerrit remote URLs', () => {
            expect(parseRemoteUrl('https://github.com/owner/repo.git')).toBeUndefined();
        });
    });

    describe('detectGerritHost', () => {
        let tempDir: string;
        let gitRoot: string;
        let mockProbe: Mock<(host: string) => Promise<boolean>>;

        beforeEach(async () => {
            tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gerrit-host-detection-test-'));
            gitRoot = path.join(tempDir, '.git');
            mockProbe = vi.fn().mockResolvedValue(true);
        });

        afterEach(async () => {
            await fs.rm(tempDir, { recursive: true, force: true });
        });

        test('detects from workspace configuration setting first', async () => {
            mockGerritHostSetting('setting.example.com');

            const host = await detectGerritHost(tempDir, null, [], mockProbe);
            expect(host).toBe('https://setting.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://setting.example.com');
        });

        test('detects from git configuration as fallback', async () => {
            // Setup Git repo with config
            cp.execSync(`git init --bare "${gitRoot}"`);
            cp.execSync(`git --git-dir="${gitRoot}" config gerrit.host "git-config-host.example.com"`);

            mockGerritHostSetting(undefined);

            const host = await detectGerritHost(tempDir, gitRoot, [], mockProbe);
            expect(host).toBe('https://git-config-host.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://git-config-host.example.com');
        });

        test('detects from .gitreview file as fallback', async () => {
            mockGerritHostSetting(undefined);

            await fs.writeFile(path.join(tempDir, '.gitreview'), '[gerrit]\nhost=review.example.com\n');

            const host = await detectGerritHost(tempDir, null, [], mockProbe);
            expect(host).toBe('https://review.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://review.example.com');
        });

        test('detects and sorts git remotes as fallback', async () => {
            mockGerritHostSetting(undefined);

            const remotes = [
                { name: 'other', url: 'https://github.com/owner/repo.git' },
                { name: 'origin', url: 'https://chromium.googlesource.com/chromium/src.git' },
            ];

            const host = await detectGerritHost(tempDir, null, remotes, mockProbe);
            expect(host).toBe('https://chromium-review.googlesource.com');
            expect(mockProbe).toHaveBeenCalledWith('https://chromium-review.googlesource.com');
        });

        test('falls back to next source when probe fails', async () => {
            // Setting host fails probing, but git config host succeeds probing
            mockGerritHostSetting('stale-setting.example.com');

            cp.execSync(`git init --bare "${gitRoot}"`);
            cp.execSync(`git --git-dir="${gitRoot}" config gerrit.host "valid-git-host.example.com"`);

            mockProbe.mockImplementation(async (h: string) => {
                return h === 'https://valid-git-host.example.com';
            });

            const host = await detectGerritHost(tempDir, gitRoot, [], mockProbe);
            expect(host).toBe('https://valid-git-host.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://stale-setting.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://valid-git-host.example.com');
        });

        test('git config host fails probing -> falls back to .gitreview', async () => {
            mockGerritHostSetting(undefined);

            cp.execSync(`git init --bare "${gitRoot}"`);
            cp.execSync(`git --git-dir="${gitRoot}" config gerrit.host "stale-git.example.com"`);

            await fs.writeFile(path.join(tempDir, '.gitreview'), '[gerrit]\nhost=valid-review.example.com\n');

            mockProbe.mockImplementation(async (h: string) => {
                return h === 'https://valid-review.example.com';
            });

            const host = await detectGerritHost(tempDir, gitRoot, [], mockProbe);
            expect(host).toBe('https://valid-review.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://stale-git.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://valid-review.example.com');
        });

        test('.gitreview host fails probing -> falls back to remotes', async () => {
            mockGerritHostSetting(undefined);

            await fs.writeFile(path.join(tempDir, '.gitreview'), '[gerrit]\nhost=stale-review.example.com\n');

            const remotes = [{ name: 'origin', url: 'https://chromium.googlesource.com/chromium/src.git' }];

            mockProbe.mockImplementation(async (h: string) => {
                return h === 'https://chromium-review.googlesource.com';
            });

            const host = await detectGerritHost(tempDir, null, remotes, mockProbe);
            expect(host).toBe('https://chromium-review.googlesource.com');
            expect(mockProbe).toHaveBeenCalledWith('https://stale-review.example.com');
            expect(mockProbe).toHaveBeenCalledWith('https://chromium-review.googlesource.com');
        });

        test('returns undefined if all candidates fail probing', async () => {
            mockGerritHostSetting('broken-setting.example.com');
            mockProbe.mockResolvedValue(false);

            const host = await detectGerritHost(tempDir, null, [], mockProbe);
            expect(host).toBeUndefined();
            expect(mockProbe).toHaveBeenCalledWith('https://broken-setting.example.com');
        });
    });
});
