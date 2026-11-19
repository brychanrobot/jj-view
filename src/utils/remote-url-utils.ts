/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostPlatform } from '../core/host/host-system';
import { normalizeRepoSeparators, trimSeparators } from '../core/path-utils';

export interface RemoteHostSettings {
    gerritHost?: string;
    gerritProject?: string;
    gitlabHost?: string;
}

/**
 * 1-based line selection range used for generating remote file line anchors.
 */
export interface RemoteLineRange {
    startLine: number;
    endLine?: number;
}

export type ResolvedRemoteTarget =
    | {
          kind: 'github' | 'gitlab';
          baseUrl: string;
      }
    | {
          kind: 'gerrit' | 'googlesource';
          host: string;
          project: string;
      };

const SCP_REMOTE_REGEX = /^(?:[^:/@\s]+@)?([^:/\s]+):(.+)$/;
const SSH_REMOTE_REGEX = /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/i;
const GIT_REMOTE_REGEX = /^git:\/\/([^:/\s]+)(?::\d+)?\/(.+)$/i;

function trimSlashes(value: string): string {
    return value.replace(/^\/+|\/+$/g, '');
}

function stripTrailingGitSuffix(value: string): string {
    return value.replace(/\.git$/i, '');
}

function isLocalFilesystemRemote(rawUrl: string): boolean {
    return (
        /^file:\/\//i.test(rawUrl) ||
        rawUrl.startsWith('/') ||
        rawUrl.startsWith('./') ||
        rawUrl.startsWith('../') ||
        /^[a-zA-Z]:[\\/]/.test(rawUrl)
    );
}

/**
 * Normalizes an HTTP/HTTPS host or base URL by removing trailing slashes and defaulting to HTTPS.
 */
export function normalizeRemoteHttpUrl(rawUrl: string): string | undefined {
    const trimmed = rawUrl.trim();
    if (!trimmed || isLocalFilesystemRemote(trimmed)) {
        return undefined;
    }

    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const parsed = new URL(withScheme);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return undefined;
        }
        parsed.username = '';
        parsed.password = '';
        const cleanPath = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.origin}${cleanPath}`;
    } catch {
        return undefined;
    }
}

/**
 * Fallback parser converting SSH, SCP-like, git://, sso://, persistent-https://, rpc://, or HTTPS
 * git remote URLs into a web repository base URL when `jj` `git_web_url()` returns empty.
 */
export function parseRemoteUrlToWebBaseUrl(remoteUrl: string): string | undefined {
    const trimmed = remoteUrl.trim();
    if (!trimmed || isLocalFilesystemRemote(trimmed)) {
        return undefined;
    }

    if (/^(?:https?|persistent-https|rpc|sso):\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            let protocol = parsed.protocol.toLowerCase();
            let hostname = parsed.hostname;
            const rawPath = parsed.pathname;

            if (protocol === 'sso:') {
                hostname = `${hostname}.googlesource.com`;
                protocol = 'https:';
            } else if (protocol !== 'http:' && protocol !== 'https:') {
                protocol = 'https:';
            }

            const cleanedPath = trimSlashes(stripTrailingGitSuffix(rawPath.replace(/\/+$/, '')));
            const finalPath = stripAuthenticatedGerritPrefix(hostname, cleanedPath);
            const hostWithPort = parsed.port && protocol === parsed.protocol.toLowerCase() ? parsed.host : hostname;
            return finalPath ? `${protocol}//${hostWithPort}/${finalPath}` : `${protocol}//${hostWithPort}`;
        } catch {
            return undefined;
        }
    }

    const sshMatch = trimmed.match(SSH_REMOTE_REGEX);
    if (sshMatch) {
        const hostname = sshMatch[1];
        const cleanedPath = stripAuthenticatedGerritPrefix(hostname, trimSlashes(stripTrailingGitSuffix(sshMatch[2])));
        return cleanedPath ? `https://${hostname}/${cleanedPath}` : `https://${hostname}`;
    }

    const gitMatch = trimmed.match(GIT_REMOTE_REGEX);
    if (gitMatch) {
        const hostname = gitMatch[1];
        const cleanedPath = trimSlashes(stripTrailingGitSuffix(gitMatch[2]));
        return cleanedPath ? `https://${hostname}/${cleanedPath}` : `https://${hostname}`;
    }

    if (!trimmed.includes('://')) {
        const scpMatch = trimmed.match(SCP_REMOTE_REGEX);
        if (scpMatch && scpMatch[1].length > 1) {
            const hostname = scpMatch[1];
            const cleanedPath = stripAuthenticatedGerritPrefix(
                hostname,
                trimSlashes(stripTrailingGitSuffix(scpMatch[2])),
            );
            return cleanedPath ? `https://${hostname}/${cleanedPath}` : undefined;
        }
    }

    return undefined;
}

function stripAuthenticatedGerritPrefix(hostname: string, projectPath: string): string {
    if (isGooglesourceHost(hostname) && projectPath.startsWith('a/')) {
        return projectPath.slice(2);
    }
    return projectPath;
}

function isGooglesourceHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return lower === 'googlesource.com' || lower.endsWith('.googlesource.com');
}

function isGitHubHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return lower === 'github.com' || lower.endsWith('.github.com');
}

function isGitLabHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return lower === 'gitlab.com' || lower.endsWith('.gitlab.com') || lower.includes('gitlab');
}

function toGitilesGooglesourceHost(hostUrl: string): string {
    try {
        const parsed = new URL(hostUrl);
        if (parsed.hostname.toLowerCase().endsWith('-review.googlesource.com')) {
            const gitilesHost = parsed.hostname.replace(/-review\.googlesource\.com$/i, '.googlesource.com');
            return `${parsed.protocol}//${gitilesHost}`;
        }
        return parsed.origin;
    } catch {
        return hostUrl.replace(/\/+$/, '');
    }
}

function extractUrlParts(
    urlStr: string,
): { origin: string; hostUrl: string; hostname: string; pathname: string } | undefined {
    try {
        const parsed = new URL(urlStr);
        return {
            origin: parsed.origin,
            hostUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`,
            hostname: parsed.hostname.toLowerCase(),
            pathname: trimSlashes(stripTrailingGitSuffix(parsed.pathname)),
        };
    } catch {
        return undefined;
    }
}

function stripLeadingGerritAuthPrefix(projectPath: string): string {
    return projectPath.startsWith('a/') ? projectPath.slice(2) : projectPath;
}

function extractRelativeProjectPath(
    remotePath: string,
    configuredHostUrl: string,
    options?: { stripGerritAuthPrefix?: boolean },
): string {
    let cleanProject = trimSlashes(stripTrailingGitSuffix(remotePath));
    try {
        const hostPath = trimSlashes(new URL(configuredHostUrl).pathname);
        if (hostPath && cleanProject.toLowerCase().startsWith(`${hostPath.toLowerCase()}/`)) {
            cleanProject = cleanProject.slice(hostPath.length + 1);
        } else if (hostPath && cleanProject.toLowerCase() === hostPath.toLowerCase()) {
            cleanProject = '';
        }
    } catch {
        // Ignore URL parsing errors and keep cleaned remotePath
    }
    return options?.stripGerritAuthPrefix ? stripLeadingGerritAuthPrefix(cleanProject) : cleanProject;
}

function sanitizeGerritProject(project: string | undefined): string | undefined {
    const trimmed = project?.trim();
    if (!trimmed) {
        return undefined;
    }
    const cleaned = trimSlashes(stripTrailingGitSuffix(trimmed));
    return cleaned || undefined;
}

function buildGerritTarget(hostUrl: string, project: string, isGoogleHost: boolean): ResolvedRemoteTarget {
    if (isGoogleHost) {
        return {
            kind: 'googlesource',
            host: toGitilesGooglesourceHost(hostUrl),
            project,
        };
    }
    return {
        kind: 'gerrit',
        host: hostUrl,
        project,
    };
}

/**
 * Resolves the forge kind and base URL / Gerrit host+project from `git_web_url`,
 * fallback remote URL parsing, and configured `jj-view.gerrit.*` / `jj-view.gitlab.host` settings.
 */
export function resolveRemoteTarget(options: {
    gitWebUrl?: string;
    remoteUrl?: string;
    settings?: RemoteHostSettings;
}): ResolvedRemoteTarget | undefined {
    const normalizedWebUrl = options.gitWebUrl ? normalizeRemoteHttpUrl(options.gitWebUrl) : undefined;
    const fallbackWebUrl = options.remoteUrl ? parseRemoteUrlToWebBaseUrl(options.remoteUrl) : undefined;
    const webBaseUrl = normalizedWebUrl ?? fallbackWebUrl;
    const webParts = webBaseUrl ? extractUrlParts(webBaseUrl) : undefined;

    const configuredGitlabHost = options.settings?.gitlabHost
        ? normalizeRemoteHttpUrl(options.settings.gitlabHost)
        : undefined;
    const configuredGerritHost = options.settings?.gerritHost
        ? normalizeRemoteHttpUrl(options.settings.gerritHost)
        : undefined;
    const configuredGerritProject = sanitizeGerritProject(options.settings?.gerritProject);

    // 1. Check configured GitLab host if applicable to this remote.
    if (configuredGitlabHost && webParts) {
        const gitlabParts = extractUrlParts(configuredGitlabHost);
        if (gitlabParts && webParts.hostname === gitlabParts.hostname) {
            const projectPath = extractRelativeProjectPath(webParts.pathname, configuredGitlabHost);
            const baseUrl = projectPath ? `${configuredGitlabHost}/${projectPath}` : configuredGitlabHost;
            return { kind: 'gitlab', baseUrl };
        }
    }

    const rawRemoteLower = options.remoteUrl?.toLowerCase() ?? '';
    const isExplicitGitHub = Boolean(webParts && isGitHubHost(webParts.hostname));
    const isExplicitGitLab = Boolean(webParts && isGitLabHost(webParts.hostname));
    const gerritSshPortHint = /:\d{4,5}\//.test(options.remoteUrl ?? '');
    const looksLikeGerrit = Boolean(
        (webParts && (isGooglesourceHost(webParts.hostname) || webParts.hostname.includes('gerrit'))) ||
            rawRemoteLower.includes('/gerrit/') ||
            rawRemoteLower.includes(':gerrit/') ||
            rawRemoteLower.startsWith('sso://') ||
            gerritSshPortHint,
    );

    // 2. Honor configured Gerrit host (+ optional project) only when applicable to this repo/remote,
    //    so a global user setting never hijacks unrelated self-hosted forges (GHE, Codeberg, Gitea).
    if (configuredGerritHost && !isExplicitGitHub && !isExplicitGitLab) {
        const gerritParts = extractUrlParts(configuredGerritHost);
        const matchesGerritHost = Boolean(
            gerritParts &&
                webParts &&
                webBaseUrl &&
                (webParts.hostname === gerritParts.hostname ||
                    toGitilesGooglesourceHost(configuredGerritHost) === toGitilesGooglesourceHost(webBaseUrl)),
        );
        if (!webParts || looksLikeGerrit || matchesGerritHost) {
            const isGoogleHost = Boolean(gerritParts && isGooglesourceHost(gerritParts.hostname));
            const targetHost = isGoogleHost ? toGitilesGooglesourceHost(configuredGerritHost) : configuredGerritHost;
            const project =
                configuredGerritProject ??
                (webParts
                    ? extractRelativeProjectPath(webParts.pathname, targetHost, { stripGerritAuthPrefix: true })
                    : undefined);
            if (project) {
                return buildGerritTarget(targetHost, project, isGoogleHost);
            }
        }
    }

    // 3. Fall back to auto-detection from resolved web base URL.
    if (!webBaseUrl || !webParts) {
        return undefined;
    }

    if (isGooglesourceHost(webParts.hostname)) {
        const gitilesHost = toGitilesGooglesourceHost(webBaseUrl);
        const project = extractRelativeProjectPath(webParts.pathname, gitilesHost, {
            stripGerritAuthPrefix: true,
        });
        if (project) {
            return { kind: 'googlesource', host: gitilesHost, project };
        }
    }

    if (isGitHubHost(webParts.hostname)) {
        return { kind: 'github', baseUrl: webBaseUrl };
    }

    if (isGitLabHost(webParts.hostname)) {
        return { kind: 'gitlab', baseUrl: webBaseUrl };
    }

    if (looksLikeGerrit && !isGooglesourceHost(webParts.hostname)) {
        // Handle common non-googlesource Gerrit subpaths (/gerrit/ or /r/) plus optional /a/ auth prefix.
        const gerritMatch = webBaseUrl.match(/^(https?:\/\/[^/]+(?:\/[^/]+)*?\/(?:gerrit|r))\/(.+)$/i);
        if (gerritMatch) {
            const project = stripLeadingGerritAuthPrefix(trimSlashes(gerritMatch[2]));
            if (project) {
                return { kind: 'gerrit', host: gerritMatch[1], project };
            }
        }
        const project = stripLeadingGerritAuthPrefix(webParts.pathname);
        if (project) {
            return { kind: 'gerrit', host: webParts.origin, project };
        }
    }

    // Default standard git web forge convention (GitHub-compatible /blob/<sha>/<path>).
    return { kind: 'github', baseUrl: webBaseUrl };
}

/**
 * Normalizes Windows backslashes when targeting Windows hosts and percent-encodes
 * each path segment cleanly while preserving literal backslashes in POSIX file names.
 */
export function encodeRemoteFilePath(relativePath: string, platform?: HostPlatform | string): string {
    const normalized = trimSeparators(normalizeRepoSeparators(relativePath, platform), platform);
    if (!normalized) {
        return '';
    }
    return normalized
        .split('/')
        .filter((segment) => segment.length > 0 && segment !== '.')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

/**
 * Converts a 0-based selection range (`TextSelectionRange`) to a normalized 1-based `RemoteLineRange`.
 */
export function toOneBasedLineRange(selection: { startLine: number; endLine: number }): RemoteLineRange {
    const rawStart = Math.max(0, Math.floor(selection.startLine)) + 1;
    const rawEnd = Math.max(0, Math.floor(selection.endLine)) + 1;
    const startLine = Math.min(rawStart, rawEnd);
    const endLine = Math.max(rawStart, rawEnd);
    return startLine === endLine ? { startLine } : { startLine, endLine };
}

function normalizeLineNumbers(startRaw: unknown, endRaw?: unknown): { start: number; end: number } | undefined {
    if (typeof startRaw !== 'number' || !Number.isFinite(startRaw) || startRaw < 1) {
        return undefined;
    }
    const start = Math.floor(startRaw);
    const end = typeof endRaw === 'number' && Number.isFinite(endRaw) && endRaw >= 1 ? Math.floor(endRaw) : start;
    return {
        start: Math.min(start, end),
        end: Math.max(start, end),
    };
}

/**
 * Safely extracts and validates a 1-based `RemoteLineRange` from an untrusted value.
 */
export function extractRemoteLineRange(value: unknown): RemoteLineRange | undefined {
    if (typeof value !== 'object' || value === null || !('startLine' in value)) {
        return undefined;
    }
    const endRaw = 'endLine' in value ? value.endLine : undefined;
    const normalized = normalizeLineNumbers(value.startLine, endRaw);
    if (!normalized) {
        return undefined;
    }
    return normalized.start === normalized.end
        ? { startLine: normalized.start }
        : { startLine: normalized.start, endLine: normalized.end };
}

function normalizeOneBasedRange(lineRange?: RemoteLineRange): { start: number; end: number } | undefined {
    if (!lineRange) {
        return undefined;
    }
    return normalizeLineNumbers(lineRange.startLine, lineRange.endLine);
}

/**
 * Formats the complete forge file URL for a resolved target, commit SHA, relative path, and optional 1-based line range.
 */
export function formatRemoteFileUrl(options: {
    target: ResolvedRemoteTarget;
    commitSha: string;
    relativePath: string;
    lineRange?: RemoteLineRange;
    platform?: HostPlatform | string;
}): string {
    const { target } = options;
    const encodedPath = encodeRemoteFilePath(options.relativePath, options.platform);
    const encodedSha = encodeURIComponent(options.commitSha.trim());
    const range = normalizeOneBasedRange(options.lineRange);
    const pathSuffix = encodedPath ? `/${encodedPath}` : '';

    switch (target.kind) {
        case 'gitlab': {
            const base = target.baseUrl.replace(/\/+$/, '');
            const url = `${base}/-/blob/${encodedSha}${pathSuffix}`;
            if (!range) {
                return url;
            }
            return range.end > range.start ? `${url}#L${range.start}-${range.end}` : `${url}#L${range.start}`;
        }
        case 'gerrit': {
            const host = target.host.replace(/\/+$/, '');
            const project = trimSlashes(target.project);
            const url = `${host}/plugins/gitiles/${project}/+/${encodedSha}${pathSuffix}`;
            return range ? `${url}#${range.start}` : url;
        }
        case 'googlesource': {
            const host = target.host.replace(/\/+$/, '');
            const project = trimSlashes(target.project);
            const url = `${host}/${project}/+/${encodedSha}${pathSuffix}`;
            return range ? `${url}#${range.start}` : url;
        }
        case 'github': {
            const base = target.baseUrl.replace(/\/+$/, '');
            const url = `${base}/blob/${encodedSha}${pathSuffix}`;
            if (!range) {
                return url;
            }
            return range.end > range.start ? `${url}#L${range.start}-L${range.end}` : `${url}#L${range.start}`;
        }
    }
}
