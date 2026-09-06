/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchWithTimeout } from './fetch-utils';
import type { LoggerChannel } from './output-channel';

/**
 * A helper to wrap cp.execFile in a Promise to prevent deep nesting of callbacks.
 */
function execFilePromise(
    file: string,
    args: string[],
    options?: cp.ExecFileOptions,
    input?: string,
): Promise<{ err: Error | null; stdout: string }> {
    return new Promise((resolve) => {
        const child = cp.execFile(file, args, options ?? {}, (err, stdout) => {
            const outStr =
                typeof stdout === 'string' ? stdout : ((stdout as Buffer | undefined)?.toString('utf8') ?? '');
            resolve({ err, stdout: outStr });
        });
        if (child.stdin) {
            if (input) {
                child.stdin.write(input);
            }
            child.stdin.end();
        }
    });
}

const gitRootCache = new Map<string, string | null>();

/**
 * Clears the in-memory cache of resolved git roots.
 */
export function clearGitRootCache(): void {
    gitRootCache.clear();
}

/**
 * Resolves the backing git directory of a jj repository using `jj git root`.
 */
export async function resolveGitRoot(repoRoot: string, binaryPath = 'jj'): Promise<string | null> {
    const normalizedRoot = path.resolve(repoRoot);
    const cacheKey = `${binaryPath}:${normalizedRoot}`;
    if (gitRootCache.has(cacheKey)) {
        return gitRootCache.get(cacheKey) ?? null;
    }
    const { err, stdout } = await execFilePromise(binaryPath, ['git', 'root'], { cwd: normalizedRoot, timeout: 10000 });
    if (err) {
        gitRootCache.set(cacheKey, null);
        return null;
    }
    if (!stdout) {
        gitRootCache.set(cacheKey, null);
        return null;
    }
    const trimmed = stdout.trim();
    gitRootCache.set(cacheKey, trimmed);
    return trimmed;
}

/**
 * Checks if a host matches a Netscape cookie domain.
 */
export function matchCookieDomain(host: string, cookieDomain: string): boolean {
    const h = host.toLowerCase();
    const cd = cookieDomain.toLowerCase();
    if (cd.startsWith('.')) {
        const domainWithoutDot = cd.slice(1);
        return h === domainWithoutDot || h.endsWith(cd);
    }
    return h === cd;
}

/**
 * Queries a configuration value from git config.
 */
export async function getGitConfig(gitDir: string | null, key: string, isPath = false): Promise<string | null> {
    if (!gitDir) {
        return null;
    }
    const args = isPath
        ? [`--git-dir=${gitDir}`, 'config', '--path', '--get', key]
        : [`--git-dir=${gitDir}`, 'config', '--get', key];
    const { err, stdout } = await execFilePromise('git', args, { timeout: 10000 });
    if (err || !stdout) {
        return null;
    }
    return stdout.trim();
}

/**
 * Resolves the path to the git cookies file.
 */
export async function getGitCookiesPath(gitDir: string | null): Promise<string | null> {
    let cookiefilePath = await getGitConfig(gitDir, 'http.cookiefile', true);

    if (!cookiefilePath && process.env.GIT_COOKIES_PATH) {
        cookiefilePath = process.env.GIT_COOKIES_PATH;
    }

    if (!cookiefilePath) {
        const defaultCookies = path.join(os.homedir(), '.gitcookies');
        try {
            await fs.access(defaultCookies);
            cookiefilePath = defaultCookies;
        } catch {
            return null;
        }
    }

    return cookiefilePath;
}

/**
 * Reads and parses cookies for a specific host from the configured git cookiefile.
 */
export async function getGitCookies(gitDir: string | null, host: string): Promise<string | null> {
    const cookiefilePath = await getGitCookiesPath(gitDir);
    if (!cookiefilePath) {
        return null;
    }

    try {
        const content = await fs.readFile(cookiefilePath, 'utf8');
        const matchingCookies: string[] = [];

        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
                continue;
            }

            const parts = trimmed.split('\t');
            if (parts.length < 7) {
                continue;
            }

            const domain = parts[0];
            const name = parts[5];
            const value = parts[6];

            if (!matchCookieDomain(host, domain)) {
                continue;
            }
            matchingCookies.push(`${name}=${value}`);
        }

        if (matchingCookies.length > 0) {
            return matchingCookies.join('; ');
        }
    } catch {
        // Ignore read/parse errors
    }

    return null;
}

/**
 * Extracts and formats key 'o' cookie from gitcookie file to Authorization header format.
 */
export async function parseCookieFile(
    filePath: string,
    host: string,
    outputChannel?: LoggerChannel,
): Promise<{ name: string; value: string } | null> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
                continue;
            }
            const fields = trimmed.split('\t');
            if (fields.length < 7) {
                continue;
            }
            const domain = fields[0];
            const xpath = fields[2];
            const name = fields[5];
            const val = fields[6];

            if (xpath !== '/' || name !== 'o' || !matchCookieDomain(host, domain)) {
                continue;
            }

            outputChannel?.debug(`[GerritAuth] Found matching cookie for domain ${domain} (key=o)`);
            if (!val.startsWith('git-')) {
                return { name: 'Authorization', value: `Bearer ${val}` };
            }

            const idx = val.indexOf('=');
            if (idx === -1) {
                continue;
            }
            const login = val.slice(0, idx);
            const secret = val.slice(idx + 1);
            const auth = Buffer.from(`${login}:${secret}`).toString('base64');
            return { name: 'Authorization', value: `Basic ${auth}` };
        }
    } catch (e) {
        outputChannel?.debug(`[GerritAuth] Failed reading or parsing cookie file ${filePath}: ${e}`);
    }
    return null;
}

/**
 * LUCI Context Authenticator.
 */
export async function getLuciToken(outputChannel?: LoggerChannel): Promise<string | null> {
    if (!process.env.LUCI_CONTEXT) {
        outputChannel?.debug('[GerritAuth] LUCI_CONTEXT environment variable not set');
        return null;
    }
    outputChannel?.debug('[GerritAuth] Running luci-auth token...');
    const { err, stdout } = await execFilePromise(
        'luci-auth',
        ['token', '-scopes', 'email https://www.googleapis.com/auth/gerritcodereview'],
        { timeout: 5000, shell: process.platform === 'win32' },
    );
    if (err) {
        outputChannel?.debug(`[GerritAuth] luci-auth execution failed: ${err.message}`);
        return null;
    }
    if (!stdout) {
        outputChannel?.debug('[GerritAuth] luci-auth returned empty stdout');
        return null;
    }
    return stdout.trim();
}

/**
 * Helper to parse extra header configuration files used by git-remote-sso.
 */
async function parseExtraHeaderFile(filePath: string): Promise<{ name: string; value: string } | null> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('extraHeader')) {
                continue;
            }
            const idx = trimmed.indexOf('=');
            if (idx === -1) {
                continue;
            }
            const headerVal = trimmed.slice(idx + 1).trim();
            const colonIdx = headerVal.indexOf(':');
            if (colonIdx === -1) {
                continue;
            }
            return {
                name: headerVal.slice(0, colonIdx).trim(),
                value: headerVal.slice(colonIdx + 1).trim(),
            };
        }
    } catch {
        // Ignore read errors
    }
    return null;
}

/**
 * Google SSO Helper Authenticator (`git-remote-sso`).
 */
export async function getSsoAuth(
    host: string,
    outputChannel?: LoggerChannel,
): Promise<{ name: string; value: string } | null> {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    outputChannel?.debug(`[GerritAuth] Checking if git-remote-sso helper exists using ${checkCmd}...`);
    const { err: checkErr, stdout: checkStdout } = await execFilePromise(checkCmd, ['git-remote-sso'], {
        shell: process.platform === 'win32',
    });
    if (checkErr || !checkStdout) {
        outputChannel?.debug('[GerritAuth] git-remote-sso helper not found in PATH');
        return null;
    }

    const ssoBin = checkStdout.trim().split(/\r?\n/)[0];
    outputChannel?.debug(`[GerritAuth] Found git-remote-sso helper: ${ssoBin}. Printing config...`);
    const { err: ssoErr, stdout: ssoStdout } = await execFilePromise(
        ssoBin,
        ['-print_config', 'sso://*.git.corp.google.com'],
        { timeout: 5000, shell: process.platform === 'win32' },
    );
    if (ssoErr || !ssoStdout) {
        outputChannel?.debug(`[GerritAuth] git-remote-sso print_config failed: ${ssoErr?.message}`);
        return null;
    }

    const config: Record<string, string> = {};
    for (const line of ssoStdout.split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx !== -1) {
            config[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    }

    const includePath = config['include.path'];
    if (includePath) {
        outputChannel?.debug(`[GerritAuth] Parsing git-remote-sso extraHeader config file: ${includePath}`);
        const extraHeader = await parseExtraHeaderFile(includePath);
        if (extraHeader) {
            return extraHeader;
        }
    }

    const cookiefile = config['http.cookiefile'];
    if (cookiefile) {
        outputChannel?.debug(`[GerritAuth] Parsing git-remote-sso cookiefile: ${cookiefile}`);
        try {
            const cookies = await parseCookieFile(cookiefile, host, outputChannel);
            if (cookies) {
                return cookies;
            }
        } catch (e) {
            outputChannel?.debug(`[GerritAuth] Failed parsing git-remote-sso cookies: ${e}`);
        }
    }

    return null;
}

/**
 * GCE Metadata Authenticator.
 */
export async function getGceAuth(outputChannel?: LoggerChannel): Promise<{ name: string; value: string } | null> {
    try {
        const metadataHost = process.env.GCE_METADATA_HOST || 'http://metadata.google.internal';
        outputChannel?.debug(`[GerritAuth] Probing GCE Metadata server at ${metadataHost}...`);
        const probeResponse = await fetchWithTimeout(metadataHost, 2000, {
            headers: { 'Metadata-Flavor': 'Google' },
        });
        if (!probeResponse.ok || probeResponse.headers.get('Metadata-Flavor') !== 'Google') {
            outputChannel?.debug('[GerritAuth] GCE Metadata probe failed or invalid flavor');
            return null;
        }

        outputChannel?.debug('[GerritAuth] Fetching GCE service account token...');
        const tokenResponse = await fetchWithTimeout(
            `${metadataHost}/computeMetadata/v1/instance/service-accounts/default/token`,
            3000,
            {
                headers: { 'Metadata-Flavor': 'Google' },
            },
        );
        if (!tokenResponse.ok) {
            outputChannel?.debug(
                `[GerritAuth] GCE service account token request failed: status ${tokenResponse.status}`,
            );
            return null;
        }
        const data = (await tokenResponse.json()) as { token_type?: string; access_token?: string };
        if (data.token_type && data.access_token) {
            return {
                name: 'Authorization',
                value: `${data.token_type} ${data.access_token}`,
            };
        }
    } catch (e) {
        outputChannel?.debug(`[GerritAuth] GCE Metadata request failed: ${e}`);
    }
    return null;
}

/**
 * Queries the git credential helper for the given host.
 */
export async function getGitCredential(
    gitDir: string | null,
    host: string,
    outputChannel?: LoggerChannel,
): Promise<{ username?: string; password?: string } | null> {
    const args = gitDir ? [`--git-dir=${gitDir}`, 'credential', 'fill'] : ['credential', 'fill'];
    const options = {
        cwd: os.homedir(),
        timeout: 15000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    };
    const input = `protocol=https\nhost=${host}\n\n`;

    outputChannel?.debug(`[GerritAuth] Running git credential helper with args: ${args.join(' ')}`);
    const { err, stdout } = await execFilePromise('git', args, options, input);
    if (err) {
        outputChannel?.debug(`[GerritAuth] git credential helper failed: ${err.message}`);
        return null;
    }
    if (!stdout) {
        outputChannel?.debug('[GerritAuth] git credential helper returned empty output');
        return null;
    }

    let username: string | undefined;
    let password: string | undefined;

    for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith('username=')) {
            username = line.substring('username='.length);
        } else if (line.startsWith('password=')) {
            password = line.substring('password='.length);
        }
    }

    if (!password) {
        outputChannel?.debug('[GerritAuth] git credential helper did not return a password');
        return null;
    }

    return { username, password };
}

/**
 * Combines cookies and credential helper checks to return authentication headers for Gerrit.
 */
export async function getGerritAuthHeader(
    gerritHost: string,
    gitDir: string | null,
    outputChannel?: LoggerChannel,
): Promise<{ name: string; value: string } | undefined> {
    let hostname = gerritHost;
    try {
        hostname = new URL(gerritHost).hostname;
    } catch {
        // Fallback to raw host string if it's not a valid URL
    }

    outputChannel?.debug(`[GerritAuth] Getting auth header for ${hostname} (gitDir=${gitDir})`);

    // 1. LUCI Context
    outputChannel?.debug('[GerritAuth] Checking LUCI Context...');
    const luciToken = await getLuciToken(outputChannel);
    if (luciToken) {
        outputChannel?.debug('[GerritAuth] Successfully authenticated using LUCI Context token');
        return { name: 'Authorization', value: `Bearer ${luciToken}` };
    }

    // 2. Google SSO
    outputChannel?.debug('[GerritAuth] Checking Google SSO helper...');
    const ssoAuth = await getSsoAuth(hostname, outputChannel);
    if (ssoAuth) {
        outputChannel?.debug('[GerritAuth] Successfully authenticated using Google SSO helper');
        return ssoAuth;
    }

    // 3. GCE Metadata
    outputChannel?.debug('[GerritAuth] Checking GCE Metadata...');
    const gceAuth = await getGceAuth(outputChannel);
    if (gceAuth) {
        outputChannel?.debug('[GerritAuth] Successfully authenticated using GCE Metadata');
        return gceAuth;
    }

    // 4. Git Cookies (parsed as Basic/Bearer matching gerrit_util.py)
    outputChannel?.debug('[GerritAuth] Checking Git Cookies...');
    const cookiefilePath = await getGitCookiesPath(gitDir);
    if (cookiefilePath) {
        outputChannel?.debug(`[GerritAuth] Reading cookies from ${cookiefilePath}`);
        const cookieAuth = await parseCookieFile(cookiefilePath, hostname, outputChannel);
        if (cookieAuth) {
            outputChannel?.debug('[GerritAuth] Successfully authenticated using Git Cookies');
            return cookieAuth;
        }
    }

    // 5. Git Credential Helper (parsed as Basic/Bearer matching gerrit_util.py)
    outputChannel?.debug('[GerritAuth] Checking Git Credential Helper...');
    const credential = await getGitCredential(gitDir, hostname, outputChannel);
    if (credential?.password) {
        outputChannel?.debug('[GerritAuth] Successfully retrieved credentials from Git Credential Helper');
        const { username, password } = credential;
        if (username?.startsWith('git-')) {
            const auth = Buffer.from(`${username}:${password}`).toString('base64');
            return { name: 'Authorization', value: `Basic ${auth}` };
        }
        if (!username || username === 'Host') {
            return { name: 'Authorization', value: `Bearer ${password}` };
        }
        const auth = Buffer.from(`${username}:${password}`).toString('base64');
        return { name: 'Authorization', value: `Basic ${auth}` };
    }

    outputChannel?.debug('[GerritAuth] No credentials resolved');
    return undefined;
}
