/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRemote } from '../code-forge-provider';
import { getGitConfig } from './gerrit-credential-utils';
import type { JjLoggerChannel } from './output-channel';

/**
 * Normalizes a Gerrit host URL by cleaning trailing slashes, prepending protocol,
 * and extracting the origin for googlesource.com hosts.
 */
export function normalizeHostUrl(hostUrl: string): string {
    let host = hostUrl.replace(/\/+$/, '');
    if (!host.startsWith('http')) {
        host = `https://${host}`;
    }
    if (host.includes('googlesource.com')) {
        try {
            const urlObj = new URL(host);
            host = urlObj.origin;
        } catch {
            // Fallback to raw host if URL parsing fails
        }
    }
    return host;
}

/**
 * Resolves the Gerrit host from the configured VS Code setting.
 */
function getHostFromSettings(outputChannel?: JjLoggerChannel): string | undefined {
    outputChannel?.debug('[GerritDetector] Checking VS Code settings for jj-view.gerrit.host...');
    const settingHost = vscode.workspace.getConfiguration('jj-view').get<string>('gerrit.host')?.trim();
    if (settingHost) {
        if (settingHost.toLowerCase() === 'true' || settingHost.toLowerCase() === 'false') {
            outputChannel?.debug(
                `[GerritDetector] Skipping settings gerrit.host: '${settingHost}' (interpreted as boolean flag)`,
            );
            return undefined;
        }
        return normalizeHostUrl(settingHost);
    }
    return undefined;
}

/**
 * Resolves the Gerrit host from the git configuration.
 */
async function getHostFromGitConfig(
    gitRoot: string | null,
    outputChannel?: JjLoggerChannel,
): Promise<string | undefined> {
    if (!gitRoot) {
        outputChannel?.debug('[GerritDetector] Git root is null, skipping git config check');
        return undefined;
    }

    outputChannel?.debug('[GerritDetector] Checking git config for gerrit.gerritserver...');
    const gerritServer = await getGitConfig(gitRoot, 'gerrit.gerritserver');
    if (gerritServer) {
        if (gerritServer.toLowerCase() === 'true' || gerritServer.toLowerCase() === 'false') {
            outputChannel?.debug(
                `[GerritDetector] Skipping git config gerrit.gerritserver: '${gerritServer}' (interpreted as boolean flag)`,
            );
        } else {
            return normalizeHostUrl(gerritServer);
        }
    }

    outputChannel?.debug('[GerritDetector] Checking git config for gerrit.host...');
    const configHost = await getGitConfig(gitRoot, 'gerrit.host');
    if (configHost) {
        if (configHost.toLowerCase() === 'true' || configHost.toLowerCase() === 'false') {
            outputChannel?.debug(
                `[GerritDetector] Skipping git config gerrit.host: '${configHost}' (interpreted as boolean flag)`,
            );
        } else {
            return normalizeHostUrl(configHost);
        }
    }
    return undefined;
}

async function getHostFromGitReview(repoRoot: string, outputChannel?: JjLoggerChannel): Promise<string | undefined> {
    const gitreviewPath = path.join(repoRoot, '.gitreview');
    outputChannel?.debug(`[GerritDetector] Checking .gitreview file at: ${gitreviewPath}`);
    try {
        const content = await fs.readFile(gitreviewPath, 'utf8');
        const match = content.match(/host=(.+)/);
        if (match?.[1]) {
            const host = normalizeHostUrl(match[1].trim());
            outputChannel?.debug(`[GerritDetector] Found host in .gitreview: ${host}`);
            return host;
        }
        outputChannel?.debug('[GerritDetector] No host entry found in .gitreview');
    } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') {
            outputChannel?.error(`[GerritDetector] Failed to parse .gitreview: ${e}`);
        } else {
            outputChannel?.debug('[GerritDetector] .gitreview file not found');
        }
    }
    return undefined;
}

/**
 * Extracts and maps a remote URL to a candidate Gerrit host.
 */
export function parseRemoteUrl(url: string): string | undefined {
    // 1. Identify SSH URLs (both standard ssh:// and SCP-like host:path syntax)
    let isSsh = false;
    let sshHost: string | undefined;

    if (url.startsWith('ssh://')) {
        isSsh = true;
        const match = url.match(/ssh:\/\/([^@]+@)?([^:/]+)(:\d+)?\/(.+)/);
        if (match) {
            sshHost = match[2];
        }
    } else if (!url.includes('://') && url.includes(':')) {
        isSsh = true;
        const colonIdx = url.indexOf(':');
        const hostPart = url.slice(0, colonIdx);
        const atIdx = hostPart.indexOf('@');
        sshHost = atIdx !== -1 ? hostPart.slice(atIdx + 1) : hostPart;
    }

    if (isSsh) {
        if (!sshHost) {
            return undefined;
        }
        // For SSH, we only map if it's a googlesource domain, contains 'gerrit' in host, or contains '/gerrit/' / ':gerrit/' in original URL
        const isGooglesource = sshHost.endsWith('googlesource.com');
        const isGerritHost = sshHost.includes('gerrit');
        const isGerritPath = url.includes('/gerrit/') || url.includes(':gerrit/');
        if (!isGooglesource && !isGerritHost && !isGerritPath) {
            return undefined;
        }
        let host = `https://${sshHost}`;
        if (isGooglesource && !sshHost.includes('-review')) {
            host = host.replace('.googlesource.com', '-review.googlesource.com');
        }
        return normalizeHostUrl(host);
    }

    // 2. HTTP/HTTPS or custom protocols (sso://, persistent-https://, rpc://)
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        return undefined;
    }

    let { protocol, hostname, pathname } = parsedUrl;

    // Handle sso:// protocol (e.g. sso://chromium/chromium/src)
    if (protocol === 'sso:') {
        hostname = `${hostname}.googlesource.com`;
        protocol = 'https:';
    }

    // Force protocol to https for custom Git helper schemes (like rpc:// or persistent-https://)
    if (protocol !== 'https:' && protocol !== 'http:') {
        protocol = 'https:';
    }

    const isGooglesource = hostname.endsWith('googlesource.com');
    const isGerritPath = pathname.includes('/gerrit/');
    if (!isGooglesource && !isGerritPath) {
        return undefined;
    }

    if (isGooglesource) {
        let host = `${protocol}//${hostname}`;
        if (!hostname.includes('-review')) {
            host = host.replace('.googlesource.com', '-review.googlesource.com');
        }
        return normalizeHostUrl(host);
    }

    // Non-googlesource Gerrit path (preserve host + path, but strip .git)
    let host = `${protocol}//${hostname}${pathname}`;
    if (host.endsWith('.git')) {
        host = host.slice(0, -4);
    }
    return normalizeHostUrl(host);
}

/**
 * Searches for a valid Gerrit host from the list of Git remotes.
 */
async function getHostFromRemotes(
    remotes: GitRemote[],
    probeFn: (host: string) => Promise<boolean>,
    outputChannel?: JjLoggerChannel,
): Promise<string | undefined> {
    outputChannel?.debug(`[GerritDetector] Scanning ${remotes.length} remotes for Gerrit host candidates`);
    const origin = remotes.find((r) => r.name === 'origin');
    const gerrit = remotes.find((r) => r.name === 'gerrit');

    const sortedRemotes = [];
    if (origin) {
        sortedRemotes.push(origin);
    }
    if (gerrit) {
        sortedRemotes.push(gerrit);
    }
    for (const r of remotes) {
        if (r.name !== 'origin' && r.name !== 'gerrit') {
            sortedRemotes.push(r);
        }
    }

    for (const { name, url } of sortedRemotes) {
        outputChannel?.debug(`[GerritDetector] Parsing remote '${name}' URL: '${url}'`);
        const candidate = parseRemoteUrl(url);
        if (!candidate) {
            outputChannel?.debug(
                `[GerritDetector] Remote '${name}' URL '${url}' was not parsed into a Gerrit candidate`,
            );
            continue;
        }

        outputChannel?.debug(`[GerritDetector] Probing candidate host: ${candidate} (from remote '${name}')`);
        if (await probeFn(candidate)) {
            outputChannel?.debug(`[GerritDetector] Candidate host ${candidate} succeeded probe`);
            return candidate;
        }
        outputChannel?.error(`[GerritDetector] Probe failed for host: ${candidate} (from remote '${name}')`);
    }

    outputChannel?.debug('[GerritDetector] No remote candidates matched or succeeded probe');
    return undefined;
}

export async function detectGerritHost(
    repoRoot: string,
    gitRoot: string | null,
    remotes: GitRemote[],
    probeFn: (host: string) => Promise<boolean>,
    outputChannel?: JjLoggerChannel,
): Promise<string | undefined> {
    outputChannel?.debug(`[GerritDetector] Starting host detection for repoRoot=${repoRoot}, gitRoot=${gitRoot}`);

    // 1. Check settings
    const settingHost = getHostFromSettings(outputChannel);
    if (settingHost) {
        outputChannel?.debug(`[GerritDetector] Found setting host candidate: ${settingHost}`);
        if (await probeFn(settingHost)) {
            outputChannel?.debug(`[GerritDetector] Setting host candidate succeeded probe: ${settingHost}`);
            return settingHost;
        }
        outputChannel?.debug(`[GerritDetector] Setting host candidate failed probe: ${settingHost}`);
    }

    // 2. Check git config
    const gitConfigHost = await getHostFromGitConfig(gitRoot, outputChannel);
    if (gitConfigHost) {
        outputChannel?.debug(`[GerritDetector] Found git config host candidate: ${gitConfigHost}`);
        if (await probeFn(gitConfigHost)) {
            outputChannel?.debug(`[GerritDetector] Git config host candidate succeeded probe: ${gitConfigHost}`);
            return gitConfigHost;
        }
        outputChannel?.debug(`[GerritDetector] Git config host candidate failed probe: ${gitConfigHost}`);
    }

    // 3. Check .gitreview
    const gitreviewHost = await getHostFromGitReview(repoRoot, outputChannel);
    if (gitreviewHost) {
        outputChannel?.debug(`[GerritDetector] Found .gitreview host candidate: ${gitreviewHost}`);
        if (await probeFn(gitreviewHost)) {
            outputChannel?.debug(`[GerritDetector] .gitreview host candidate succeeded probe: ${gitreviewHost}`);
            return gitreviewHost;
        }
        outputChannel?.debug(`[GerritDetector] .gitreview host candidate failed probe: ${gitreviewHost}`);
    }

    // 4. Check remotes
    outputChannel?.debug('[GerritDetector] Falling back to remote URL candidates detection');
    const remoteHost = await getHostFromRemotes(remotes, probeFn, outputChannel);
    if (remoteHost) {
        outputChannel?.debug(`[GerritDetector] Remote host candidate succeeded probe: ${remoteHost}`);
        return remoteHost;
    }

    outputChannel?.debug('[GerritDetector] No valid Gerrit host detected');
    return undefined;
}
