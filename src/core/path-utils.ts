/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import pathe from 'pathe';
import type { HostPlatform } from './host/host-system';

const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:(?:$|[/\\])/;
const WINDOWS_UNC_PREFIX = /^\\\\[^\\]/;
const WINDOWS_UNC_SHARE_REGEX = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(.*)$/;

/**
 * Returns `true` when running on (or targeting) a Windows host platform.
 */
export function isWindowsPlatform(platform?: HostPlatform | string): boolean {
    if (platform !== undefined) {
        return platform === 'win32';
    }
    return globalThis.process?.platform === 'win32';
}

/**
 * Detects explicit Windows drive or backslash UNC prefixes (used when `platform` is omitted
 * in cross-platform path helpers such as unit tests running Windows path inputs on POSIX).
 */
export function isWindowsStylePath(filePath: string): boolean {
    return WINDOWS_DRIVE_PREFIX.test(filePath) || WINDOWS_UNC_PREFIX.test(filePath);
}

/**
 * Detects Windows UNC share roots in forward-slash (`//server/share/...`) or backslash
 * (`\\server\share\...`) form.
 */
export function isWindowsUncSharePath(filePath: string): boolean {
    return WINDOWS_UNC_SHARE_REGEX.test(filePath);
}

function extractWindowsUncShare(filePath: string): { root: string; rest: string } | undefined {
    const match = WINDOWS_UNC_SHARE_REGEX.exec(filePath);
    if (!match) {
        return undefined;
    }
    const [, server, share, rawRest] = match;
    const forwardRest = rawRest.replace(/\\/g, '/');
    return {
        root: `//${server}/${share}`,
        rest: forwardRest.length > 0 ? (forwardRest.startsWith('/') ? forwardRest : `/${forwardRest}`) : '/',
    };
}

function winNormalize(filePath: string): string {
    const unc = extractWindowsUncShare(filePath);
    if (!unc) {
        return pathe.normalize(filePath);
    }
    const normRest = posixNormalize(unc.rest);
    return normRest === '/' ? unc.root : `${unc.root}${normRest}`;
}

function winJoin(segments: readonly string[]): string {
    const nonEmpty = segments.filter((s) => s.length > 0);
    if (nonEmpty.length === 0) {
        return '.';
    }
    const joined = nonEmpty.join('/');
    if (extractWindowsUncShare(joined)) {
        return winNormalize(joined);
    }
    return pathe.join(...segments);
}

function winResolve(segments: readonly string[]): string {
    let rightmostUncIndex = -1;
    let rightmostAbsIndex = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (!seg) {
            continue;
        }
        if (extractWindowsUncShare(seg)) {
            rightmostUncIndex = i;
            break;
        }
        if (rightmostAbsIndex === -1 && pathe.isAbsolute(seg)) {
            rightmostAbsIndex = i;
            break;
        }
    }
    if (rightmostUncIndex !== -1) {
        const uncJoined = segments
            .slice(rightmostUncIndex)
            .filter((s) => s.length > 0)
            .join('/');
        const norm = winNormalize(uncJoined);
        return norm.length > 1 && norm.endsWith('/') ? norm.slice(0, -1) : norm;
    }
    return pathe.resolve(...segments);
}

function shouldUseWindowsSemantics(platform: HostPlatform | string | undefined, ...samplePaths: string[]): boolean {
    if (platform !== undefined) {
        return platform === 'win32';
    }
    if (globalThis.process?.platform === 'win32') {
        return true;
    }
    return samplePaths.some((p) => isWindowsStylePath(p));
}

/**
 * Normalizes backslashes to forward slashes strictly on Windows hosts so literal
 * backslashes in POSIX file names remain intact.
 */
export function normalizeRepoSeparators(filePath: string, platform?: HostPlatform | string): string {
    return isWindowsPlatform(platform) ? filePath.replace(/\\/g, '/') : filePath;
}

/**
 * Normalizes path separators to forward slashes when targeting Windows OR when `filePath`
 * carries an explicit Windows drive/UNC prefix while `platform` is unspecified.
 */
export function normalizeSeparatorsForHost(filePath: string, platform?: HostPlatform | string): string {
    return shouldUseWindowsSemantics(platform, filePath) ? filePath.replace(/\\/g, '/') : filePath;
}

/**
 * Strips leading directory separators (`/` on POSIX, `/` or `\` on Windows).
 */
export function stripLeadingSeparators(filePath: string, platform?: HostPlatform | string): string {
    return isWindowsPlatform(platform) ? filePath.replace(/^[/\\]+/, '') : filePath.replace(/^\/+/, '');
}

/**
 * Strips leading and trailing directory separators (`/` on POSIX, `/` or `\` on Windows).
 */
export function trimSeparators(filePath: string, platform?: HostPlatform | string): string {
    return isWindowsPlatform(platform) ? filePath.replace(/^[/\\]+|[/\\]+$/g, '') : filePath.replace(/^\/+|\/+$/g, '');
}

/**
 * Splits a repository-relative path into directory/file segments (`/` on POSIX, `/` or `\` on Windows).
 */
export function splitRepoPathSegments(filePath: string, platform?: HostPlatform | string): string[] {
    return isWindowsPlatform(platform) ? filePath.split(/[/\\]/) : filePath.split('/');
}

/**
 * Pure POSIX `isAbsolute` that does not treat `\` as a separator.
 */
export function posixIsAbsolute(filePath: string): boolean {
    return filePath.startsWith('/');
}

/**
 * Pure POSIX `normalize` preserving literal `\` in file names.
 */
export function posixNormalize(filePath: string): string {
    if (filePath.length === 0) {
        return '.';
    }

    const isAbs = filePath.startsWith('/');
    const trailingSlash = filePath.length > 1 && filePath.endsWith('/');
    const stack: string[] = [];

    for (const part of filePath.split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (stack.length > 0 && stack[stack.length - 1] !== '..') {
                stack.pop();
            } else if (!isAbs) {
                stack.push('..');
            }
            continue;
        }
        stack.push(part);
    }

    const body = stack.join('/');
    if (isAbs) {
        if (!body) {
            return '/';
        }
        return trailingSlash ? `/${body}/` : `/${body}`;
    }
    if (!body) {
        return trailingSlash ? './' : '.';
    }
    return trailingSlash ? `${body}/` : body;
}

/**
 * Pure POSIX `join` preserving literal `\` in file names.
 */
export function posixJoin(segments: readonly string[]): string {
    const nonEmpty = segments.filter((seg) => seg.length > 0);
    if (nonEmpty.length === 0) {
        return '.';
    }
    return posixNormalize(nonEmpty.join('/'));
}

/**
 * Pure POSIX `resolve` preserving literal `\` in file names.
 */
export function posixResolve(segments: readonly string[]): string {
    let resolved = '';
    let resolvedAbsolute = false;

    for (let i = segments.length - 1; i >= 0 && !resolvedAbsolute; i--) {
        const segment = segments[i];
        if (!segment) {
            continue;
        }
        resolved = resolved ? `${segment}/${resolved}` : segment;
        resolvedAbsolute = segment.startsWith('/');
    }

    if (!resolvedAbsolute) {
        const cwd = globalThis.process?.cwd?.() ?? '/';
        resolved = resolved ? `${cwd}/${resolved}` : cwd;
    }

    const normalized = posixNormalize(resolved);
    if (normalized.length > 1 && normalized.endsWith('/')) {
        return normalized.slice(0, -1);
    }
    return normalized;
}

/**
 * Pure POSIX `relative` preserving literal `\` in file names.
 */
export function posixRelative(from: string, to: string): string {
    const resolvedFrom = posixResolve([from]);
    const resolvedTo = posixResolve([to]);
    if (resolvedFrom === resolvedTo) {
        return '';
    }

    const fromParts = resolvedFrom === '/' ? [] : resolvedFrom.slice(1).split('/');
    const toParts = resolvedTo === '/' ? [] : resolvedTo.slice(1).split('/');
    const minLen = Math.min(fromParts.length, toParts.length);

    let common = 0;
    while (common < minLen && fromParts[common] === toParts[common]) {
        common++;
    }

    const upCount = fromParts.length - common;
    const parts: string[] = [];
    for (let i = 0; i < upCount; i++) {
        parts.push('..');
    }
    for (let i = common; i < toParts.length; i++) {
        parts.push(toParts[i]);
    }
    return parts.join('/');
}

/**
 * Pure POSIX `dirname` preserving literal `\` in file names.
 */
export function posixDirname(filePath: string): string {
    if (filePath.length === 0) {
        return '.';
    }

    let end = filePath.length;
    while (end > 0 && filePath[end - 1] === '/') {
        end--;
    }
    if (end === 0) {
        return filePath.startsWith('/') ? '/' : '.';
    }

    const lastSlash = filePath.lastIndexOf('/', end - 1);
    if (lastSlash === -1) {
        return '.';
    }

    let dirEnd = lastSlash;
    while (dirEnd > 0 && filePath[dirEnd - 1] === '/') {
        dirEnd--;
    }
    return dirEnd === 0 ? '/' : filePath.slice(0, dirEnd);
}

/**
 * Pure POSIX `basename` preserving literal `\` in file names.
 */
export function posixBasename(filePath: string): string {
    if (filePath.length === 0) {
        return '';
    }

    let end = filePath.length;
    while (end > 0 && filePath[end - 1] === '/') {
        end--;
    }
    if (end === 0) {
        return '';
    }

    const lastSlash = filePath.lastIndexOf('/', end - 1);
    return lastSlash === -1 ? filePath.slice(0, end) : filePath.slice(lastSlash + 1, end);
}

/**
 * Pure POSIX `extname` preserving literal `\` in file names.
 */
export function posixExtname(filePath: string): string {
    const base = posixBasename(filePath);
    if (!base || base === '.' || base === '..') {
        return '';
    }
    const dotIndex = base.lastIndexOf('.');
    return dotIndex <= 0 ? '' : base.slice(dotIndex);
}

/**
 * Platform-aware `isAbsolute` (uses POSIX semantics unless Windows host or Windows path).
 */
export function pathIsAbsolute(filePath: string, platform?: HostPlatform | string): boolean {
    if (shouldUseWindowsSemantics(platform, filePath)) {
        return extractWindowsUncShare(filePath) !== undefined || pathe.isAbsolute(filePath);
    }
    return posixIsAbsolute(filePath);
}

/**
 * Platform-aware `normalize` (preserves literal `\` on POSIX and UNC prefixes on Windows).
 */
export function pathNormalize(filePath: string, platform?: HostPlatform | string): string {
    if (shouldUseWindowsSemantics(platform, filePath)) {
        return winNormalize(filePath);
    }
    return posixNormalize(filePath);
}

/**
 * Platform-aware `join` (preserves literal `\` on POSIX and UNC prefixes on Windows).
 */
export function pathJoin(segments: readonly string[], platform?: HostPlatform | string): string {
    if (shouldUseWindowsSemantics(platform, ...segments)) {
        return winJoin(segments);
    }
    return posixJoin(segments);
}

/**
 * Platform-aware `resolve` (preserves literal `\` on POSIX and UNC prefixes on Windows).
 */
export function pathResolve(segments: readonly string[], platform?: HostPlatform | string): string {
    if (shouldUseWindowsSemantics(platform, ...segments)) {
        return winResolve(segments);
    }
    return posixResolve(segments);
}

/**
 * Platform-aware `relative` (preserves literal `\` on POSIX and UNC roots on Windows).
 */
export function pathRelative(from: string, to: string, platform?: HostPlatform | string): string {
    if (shouldUseWindowsSemantics(platform, from, to)) {
        const fromUnc = extractWindowsUncShare(from);
        const toUnc = extractWindowsUncShare(to);
        if (fromUnc || toUnc) {
            if (!fromUnc || !toUnc || fromUnc.root.toLowerCase() !== toUnc.root.toLowerCase()) {
                return winNormalize(to);
            }
            return posixRelative(posixNormalize(fromUnc.rest), posixNormalize(toUnc.rest));
        }
        return pathe.relative(from, to);
    }
    return posixRelative(from, to);
}

/**
 * Platform-aware `dirname` (preserves literal `\` on POSIX and UNC roots on Windows).
 */
export function pathDirname(filePath: string, platform?: HostPlatform | string): string {
    if (shouldUseWindowsSemantics(platform, filePath)) {
        const unc = extractWindowsUncShare(filePath);
        if (unc) {
            const normRest = posixNormalize(unc.rest);
            if (normRest === '/') {
                return unc.root;
            }
            const restDir = posixDirname(normRest);
            return restDir === '/' ? unc.root : `${unc.root}${restDir}`;
        }
        return pathe.dirname(filePath);
    }
    return posixDirname(filePath);
}

/**
 * Platform-aware `basename` (preserves literal `\` on POSIX and UNC roots on Windows).
 */
export function pathBasename(filePath: string, platform?: HostPlatform | string): string {
    if (shouldUseWindowsSemantics(platform, filePath)) {
        const unc = extractWindowsUncShare(filePath);
        if (unc) {
            const normRest = posixNormalize(unc.rest);
            return normRest === '/' ? '' : posixBasename(normRest);
        }
        return pathe.basename(filePath);
    }
    return posixBasename(filePath);
}

/**
 * Platform-aware `extname` (preserves literal `\` on POSIX).
 */
export function pathExtname(filePath: string, platform?: HostPlatform | string): string {
    if (shouldUseWindowsSemantics(platform, filePath)) {
        return pathe.extname(filePath);
    }
    return posixExtname(filePath);
}

/**
 * Checks whether a path equals or sits inside a filesystem root directory.
 */
export function isFilesystemRootPath(filePath: string, platform?: HostPlatform | string): boolean {
    if (shouldUseWindowsSemantics(platform, filePath)) {
        const normalized = winNormalize(filePath);
        return (
            normalized === '/' || /^[a-zA-Z]:[/\\]?$/.test(normalized) || /^\/\/[^/]+(?:\/[^/]+)?\/?$/.test(normalized)
        );
    }
    return posixNormalize(filePath) === '/';
}

/**
 * Produces a normalized comparison key for filesystem paths (lowercasing on case-insensitive OSes / Windows paths).
 */
export function toFsComparisonKey(filePath: string, platform?: HostPlatform | string): string {
    const normalized = pathNormalize(filePath, platform);
    const effectivePlatform = platform ?? globalThis.process?.platform;
    if (
        effectivePlatform === 'win32' ||
        effectivePlatform === 'darwin' ||
        (platform === undefined && (isWindowsStylePath(normalized) || isWindowsUncSharePath(normalized)))
    ) {
        return normalized.toLowerCase();
    }
    return normalized;
}

const GIT_SIMPLE_ESCAPES: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
};

/**
 * Unquotes a Git C-escaped path literal (preserving literal backslashes and UTF-8 octal sequences).
 */
export function unquoteGitPath(rawPath: string): string {
    if (!rawPath.startsWith('"') || !rawPath.endsWith('"')) {
        return rawPath;
    }
    try {
        const parsed: unknown = JSON.parse(rawPath);
        if (typeof parsed === 'string') {
            return parsed;
        }
    } catch {
        // Fallback for Git's C-style octal escapes (e.g. \303\251) and \a/\v escapes
    }
    const inner = rawPath.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch !== '\\' || i + 1 >= inner.length) {
            const encoded = new TextEncoder().encode(ch);
            for (const b of encoded) {
                bytes.push(b);
            }
            continue;
        }
        const octalMatch = /^[0-7]{3}/.exec(inner.slice(i + 1));
        if (octalMatch) {
            bytes.push(Number.parseInt(octalMatch[0], 8));
            i += 3;
            continue;
        }
        const next = inner[i + 1];
        const simpleByte = GIT_SIMPLE_ESCAPES[next];
        if (simpleByte !== undefined) {
            bytes.push(simpleByte);
            i++;
            continue;
        }
        bytes.push(next.charCodeAt(0) & 0xff);
        i++;
    }
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}
