/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
    clearGitRootCache,
    getGerritAuthHeader,
    getGitCookies,
    getGitCredential,
    matchCookieDomain,
    resolveGitRoot,
} from '../utils/gerrit-credential-utils';
import { TestRepo } from './test-repo';

describe('Credential Utils', () => {
    let tempDir: string;
    let repo: TestRepo | undefined;

    beforeEach(async () => {
        clearGitRootCache();
        repo = undefined;
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-view-cred-test-'));
    });

    afterEach(async () => {
        clearGitRootCache();
        if (repo) {
            repo.dispose();
        }
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    });

    describe('resolveGitRoot', () => {
        test('resolves git directory of a real jj repo', async () => {
            repo = new TestRepo();
            repo.init();

            const gitRoot = await resolveGitRoot(repo.path);
            expect(gitRoot).not.toBeNull();
            expect(gitRoot).toBeSameFsPath(path.join(repo.path, '.git'));
        });

        test('caches resolved git root on subsequent calls', async () => {
            repo = new TestRepo();
            repo.init();

            const gitRoot1 = await resolveGitRoot(repo.path);
            const gitRoot2 = await resolveGitRoot(repo.path);
            expect(gitRoot1).toBe(gitRoot2);
            expect(gitRoot1).toBeSameFsPath(path.join(repo.path, '.git'));
        });

        test('clearGitRootCache clears cached results', async () => {
            repo = new TestRepo();
            repo.init();

            const gitRoot1 = await resolveGitRoot(repo.path);
            clearGitRootCache();
            const gitRoot2 = await resolveGitRoot(repo.path);
            expect(gitRoot1).toEqual(gitRoot2);
        });

        test('returns null when not in a jj repo and caches the negative result', async () => {
            const result1 = await resolveGitRoot(tempDir);
            expect(result1).toBeNull();

            const result2 = await resolveGitRoot(tempDir);
            expect(result2).toBeNull();
        });
    });

    describe('matchCookieDomain', () => {
        test('matches exact hostnames case insensitively', () => {
            expect(matchCookieDomain('gerrit.example.com', 'gerrit.example.com')).toBe(true);
            expect(matchCookieDomain('GERRIT.example.com', 'gerrit.EXAMPLE.com')).toBe(true);
            expect(matchCookieDomain('gerrit.example.com', 'other.com')).toBe(false);
        });

        test('matches subdomains for wildcard cookie domains', () => {
            expect(matchCookieDomain('gerrit.example.com', '.example.com')).toBe(true);
            expect(matchCookieDomain('example.com', '.example.com')).toBe(true);
            expect(matchCookieDomain('sub.gerrit.example.com', '.example.com')).toBe(true);
            expect(matchCookieDomain('other.com', '.example.com')).toBe(false);
        });
    });

    describe('getGitCookies', () => {
        test('reads cookies from configured git cookiefile', async () => {
            const gitDir = path.join(tempDir, 'git-repo.git');
            cp.execSync(`git init --bare "${gitDir}"`);

            const cookieFile = path.join(tempDir, 'cookies.txt');
            await fs.writeFile(
                cookieFile,
                '# Netscape HTTP Cookie File\n' +
                    'gerrit.example.com\tFALSE\t/\tTRUE\t0\to\tusername=password\n' +
                    '.other.com\tTRUE\t/\tTRUE\t0\tauth\ttoken_val\n',
            );

            cp.execSync(`git --git-dir="${gitDir}" config http.cookiefile "${cookieFile}"`);

            const cookies = await getGitCookies(gitDir, 'gerrit.example.com');
            expect(cookies).toBe('o=username=password');
        });

        test('returns null if no cookies file exists', async () => {
            const gitDir = path.join(tempDir, 'git-repo-empty.git');
            cp.execSync(`git init --bare "${gitDir}"`);

            const cookies = await getGitCookies(gitDir, 'gerrit.example.com');
            expect(cookies).toBeNull();
        });
    });

    describe('getGitCredential', () => {
        test('invokes git credential fill and parses output', async () => {
            const gitDir = path.join(tempDir, 'git-repo-cred.git');
            cp.execSync(`git init --bare "${gitDir}"`);
            cp.execSync(
                `git --git-dir="${gitDir}" config credential.helper "!f() { echo username=testuser; echo password=testpassword; }; f"`,
            );

            const creds = await getGitCredential(gitDir, 'gerrit.example.com');
            expect(creds).toEqual({ username: 'testuser', password: 'testpassword' });
        });

        test('returns null when credential helper returns no password', async () => {
            const gitDir = path.join(tempDir, 'git-repo-cred-nopw.git');
            cp.execSync(`git init --bare "${gitDir}"`);
            cp.execSync(`git --git-dir="${gitDir}" config credential.helper "!f() { echo username=testuser; }; f"`);

            const creds = await getGitCredential(gitDir, 'gerrit.example.com');
            expect(creds).toBeNull();
        });

        test('returns null when git credential helper invocation fails', async () => {
            const gitDir = path.join(tempDir, 'git-repo-cred-fail.git');
            cp.execSync(`git init --bare "${gitDir}"`);
            cp.execSync(`git --git-dir="${gitDir}" config credential.helper "!f() { exit 1; }; f"`);

            const creds = await getGitCredential(gitDir, 'gerrit.example.com');
            expect(creds).toBeNull();
        });
    });

    describe('getGerritAuthHeader', () => {
        test('prioritizes LUCI token if present', async () => {
            const isWindows = process.platform === 'win32';
            const scriptName = isWindows ? 'luci-auth.cmd' : 'luci-auth';
            const scriptPath = path.join(tempDir, scriptName);

            if (isWindows) {
                await fs.writeFile(
                    scriptPath,
                    '@echo off\r\n' +
                        'if "%1"=="token" if "%2"=="-scopes" (\r\n' +
                        '  echo fake_luci_token_123\r\n' +
                        '  exit /b 0\r\n' +
                        ')\r\n' +
                        'exit /b 1\r\n',
                );
            } else {
                await fs.writeFile(
                    scriptPath,
                    '#!/bin/sh\n' +
                        'if [ "$1" = "token" ] && [ "$2" = "-scopes" ]; then\n' +
                        '  echo "fake_luci_token_123"\n' +
                        '  exit 0\n' +
                        'fi\n' +
                        'exit 1\n',
                );
                await fs.chmod(scriptPath, 0o755);
            }

            const originalPath = process.env.PATH;
            const originalLuciContext = process.env.LUCI_CONTEXT;

            process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;
            process.env.LUCI_CONTEXT = '{"some":"context"}';

            try {
                const header = await getGerritAuthHeader('https://gerrit.example.com', null);
                expect(header).toEqual({ name: 'Authorization', value: 'Bearer fake_luci_token_123' });
            } finally {
                process.env.PATH = originalPath;
                process.env.LUCI_CONTEXT = originalLuciContext;
            }
        });

        test('uses Google SSO helper if available', async () => {
            const isWindows = process.platform === 'win32';
            const scriptName = isWindows ? 'git-remote-sso.cmd' : 'git-remote-sso';
            const scriptPath = path.join(tempDir, scriptName);

            const extraConfig = path.join(tempDir, 'extra_headers.config');
            await fs.writeFile(extraConfig, 'extraHeader = Authorization: Basic c3NvX3VzZXI6c3NvX3Bhc3M=\n');

            if (isWindows) {
                await fs.writeFile(
                    scriptPath,
                    '@echo off\r\n' +
                        'if "%1"=="-print_config" (\r\n' +
                        `  echo include.path=${extraConfig}\r\n` +
                        '  exit /b 0\r\n' +
                        ')\r\n' +
                        'exit /b 1\r\n',
                );
            } else {
                await fs.writeFile(
                    scriptPath,
                    '#!/bin/sh\n' +
                        'if [ "$1" = "-print_config" ]; then\n' +
                        `  echo "include.path=${extraConfig}"\n` +
                        '  exit 0\n' +
                        'fi\n' +
                        'exit 1\n',
                );
                await fs.chmod(scriptPath, 0o755);
            }

            const originalPath = process.env.PATH;
            process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;

            try {
                const header = await getGerritAuthHeader('https://gerrit.example.com', null);
                expect(header).toEqual({ name: 'Authorization', value: 'Basic c3NvX3VzZXI6c3NvX3Bhc3M=' });
            } finally {
                process.env.PATH = originalPath;
            }
        });

        test('uses GCE Metadata if available', async () => {
            const server = http.createServer((req, res) => {
                if (req.url === '/') {
                    res.writeHead(200, { 'Metadata-Flavor': 'Google', 'Content-Type': 'text/plain' });
                    res.end('OK');
                } else if (req.url === '/computeMetadata/v1/instance/service-accounts/default/token') {
                    res.writeHead(200, { 'Metadata-Flavor': 'Google', 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ token_type: 'Bearer', access_token: 'fake_gce_token_789' }));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });

            const port = await new Promise<number>((resolve) => {
                server.listen(0, '127.0.0.1', () => {
                    const address = server.address();
                    if (address && typeof address !== 'string') {
                        resolve(address.port);
                    }
                });
            });

            const originalGceHost = process.env.GCE_METADATA_HOST;
            process.env.GCE_METADATA_HOST = `http://127.0.0.1:${port}`;

            try {
                const header = await getGerritAuthHeader('https://gerrit.example.com', null);
                expect(header).toEqual({ name: 'Authorization', value: 'Bearer fake_gce_token_789' });
            } finally {
                process.env.GCE_METADATA_HOST = originalGceHost;
                server.close();
            }
        });

        test('prioritizes git cookies (Bearer format)', async () => {
            const gitDir = path.join(tempDir, 'git-repo-header-cookie.git');
            cp.execSync(`git init --bare "${gitDir}"`);

            const cookieFile = path.join(tempDir, 'cookies.txt');
            await fs.writeFile(cookieFile, 'gerrit.example.com\tFALSE\t/\tTRUE\t0\to\tcookieval\n');
            cp.execSync(`git --git-dir="${gitDir}" config http.cookiefile "${cookieFile}"`);

            const header = await getGerritAuthHeader('https://gerrit.example.com', gitDir);
            expect(header).toEqual({ name: 'Authorization', value: 'Bearer cookieval' });
        });

        test('prioritizes git cookies (Basic format with git- prefix)', async () => {
            const gitDir = path.join(tempDir, 'git-repo-header-cookie-basic.git');
            cp.execSync(`git init --bare "${gitDir}"`);

            const cookieFile = path.join(tempDir, 'cookies.txt');
            await fs.writeFile(cookieFile, 'gerrit.example.com\tFALSE\t/\tTRUE\t0\to\tgit-user=pass123\n');
            cp.execSync(`git --git-dir="${gitDir}" config http.cookiefile "${cookieFile}"`);

            const header = await getGerritAuthHeader('https://gerrit.example.com', gitDir);
            const expectedAuth = Buffer.from('git-user:pass123').toString('base64');
            expect(header).toEqual({ name: 'Authorization', value: `Basic ${expectedAuth}` });
        });

        test('falls back to credential helper basic auth', async () => {
            const gitDir = path.join(tempDir, 'git-repo-header-helper.git');
            cp.execSync(`git init --bare "${gitDir}"`);
            cp.execSync(
                `git --git-dir="${gitDir}" config credential.helper "!f() { echo username=git-luci; echo password=token123; }; f"`,
            );

            const header = await getGerritAuthHeader('https://gerrit.example.com', gitDir);
            const expectedAuth = Buffer.from('git-luci:token123').toString('base64');
            expect(header).toEqual({ name: 'Authorization', value: `Basic ${expectedAuth}` });
        });

        test('supports non-URL host strings', async () => {
            const gitDir = path.join(tempDir, 'git-repo-header-non-url.git');
            cp.execSync(`git init --bare "${gitDir}"`);

            const cookieFile = path.join(tempDir, 'cookies.txt');
            await fs.writeFile(cookieFile, 'gerrit.example.com\tFALSE\t/\tTRUE\t0\to\tcookieval\n');
            cp.execSync(`git --git-dir="${gitDir}" config http.cookiefile "${cookieFile}"`);

            const header = await getGerritAuthHeader('gerrit.example.com', gitDir);
            expect(header).toEqual({ name: 'Authorization', value: 'Bearer cookieval' });
        });

        test('returns undefined when no auth is available', async () => {
            const gitDir = path.join(tempDir, 'git-repo-header-noauth.git');
            cp.execSync(`git init --bare "${gitDir}"`);

            const header = await getGerritAuthHeader('https://gerrit.example.com', gitDir);
            expect(header).toBeUndefined();
        });
    });
});
