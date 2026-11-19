/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { match } from 'ts-pattern';
import { URI, Utils } from 'vscode-uri';
import { LruCache } from '../utils/lru-cache';
import type { HostFs, HostPlatform } from './host/host-system';
import type { JjStatusEntry } from './jj-types';
import {
    isFilesystemRootPath,
    isWindowsPlatform,
    isWindowsStylePath,
    isWindowsUncSharePath,
    normalizeRepoSeparators,
    pathBasename,
    pathDirname,
    pathIsAbsolute,
    pathJoin,
    pathNormalize,
    pathRelative,
    pathResolve,
    stripLeadingSeparators,
    toFsComparisonKey,
} from './path-utils';

export type Uri = URI;
export const Uri = Object.assign(URI, {
    joinPath: Utils.joinPath,
});

export interface FileStatLike {
    type: number;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: number;
}

export type JjViewQuery =
    | { mode: 'diff'; root?: string; base: string; side: 'left' | 'right' }
    | { mode: 'revision'; root?: string; revision: string }
    | {
          mode: 'uploaded';
          root?: string;
          changeId: string;
          commitId?: string;
          blobSha?: string;
          remoteRevision?: string;
          changeNumber?: number;
      }
    | { mode: 'text'; root?: string; text: string };

export function encodeJjViewQuery(query: JjViewQuery): string {
    const params = new URLSearchParams();
    if (query.root) {
        params.set('root', query.root);
    }
    match(query)
        .with({ mode: 'diff' }, (q) => {
            params.set('base', q.base);
            params.set('side', q.side);
        })
        .with({ mode: 'revision' }, (q) => {
            params.set('revision', q.revision);
        })
        .with({ mode: 'uploaded' }, (q) => {
            params.set('mode', 'uploaded');
            params.set('changeId', q.changeId);
            if (q.commitId) {
                params.set('commitId', q.commitId);
            }
            if (q.blobSha) {
                params.set('blobSha', q.blobSha);
            }
            if (q.remoteRevision) {
                params.set('remoteRevision', q.remoteRevision);
            }
            if (q.changeNumber !== undefined) {
                params.set('changeNumber', String(q.changeNumber));
            }
        })
        .with({ mode: 'text' }, (q) => {
            params.set('mode', 'text');
            params.set('text', q.text);
        })
        .exhaustive();
    return params.toString();
}

function stripPrefix(str: string | undefined): string {
    return (str || '').replace(/^[#?]/, '');
}

/**
 * Helper to parse URL parameters from a URI, checking fragment first with query fallback.
 */
export function getUriParams(uri: Uri): URLSearchParams {
    const fragmentStr = stripPrefix(uri.fragment);
    const queryStr = stripPrefix(uri.query);
    const combinedStr = fragmentStr && queryStr ? `${fragmentStr}&${queryStr}` : fragmentStr || queryStr;
    return new URLSearchParams(combinedStr);
}

export function decodeJjViewQuery(uri: Uri): JjViewQuery {
    const params = getUriParams(uri);
    const root = params.get('root') || params.get('repoRoot') || undefined;
    const mode = params.get('mode');

    if (mode === 'uploaded') {
        const changeId = params.get('changeId') || '';
        const commitId = params.get('commitId') || undefined;
        const blobSha = params.get('blobSha') || undefined;
        const remoteRevision = params.get('remoteRevision') || undefined;
        const rawNum = params.get('changeNumber');
        const parsedNum = rawNum !== null && rawNum !== '' ? Number.parseInt(rawNum, 10) : Number.NaN;
        const changeNumber = Number.isFinite(parsedNum) ? parsedNum : undefined;
        return { mode: 'uploaded', root, changeId, commitId, blobSha, remoteRevision, changeNumber };
    }

    if (mode === 'text') {
        const text = params.get('text') || '';
        return { mode: 'text', root, text };
    }

    const revision = params.get('revision');
    const base = params.get('base');
    const side = params.get('side');

    if (revision) {
        return { mode: 'revision', root, revision };
    }
    if (base && side) {
        if (!isDiffSide(side)) {
            throw new Error(`Invalid side in jj-view query: ${side}`);
        }
        return { mode: 'diff', root, base, side };
    }
    throw new Error(`Invalid query combination for jj-view: ${uri.toString()}`);
}

function isDiffSide(side: string): side is 'left' | 'right' {
    return side === 'left' || side === 'right';
}

/**
 * Unconditionally replaces backslashes with forward slashes.
 * Prefer `normalizeRepoSeparators` / `normalizeSeparatorsForHost` for platform-aware paths.
 */
export function toForwardSlash(p: string): string {
    return p.replace(/\\/g, '/');
}

/**
 * Synchronous 32-bit FNV-1a hash function returning an 8-character hex string.
 * Used for deterministic caching signatures without requiring node:crypto.
 */
export function fnv1aHash(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Determines whether a given revision refers to the current working copy.
 */
export function isWorkingCopyRevision(revision: string, workingCopyChangeId?: string): boolean {
    if (revision === '@') {
        return true;
    }
    if (!revision || !workingCopyChangeId) {
        return false;
    }
    if (revision === workingCopyChangeId) {
        return true;
    }
    const minPrefixLen = 3;
    if (revision.length >= minPrefixLen && workingCopyChangeId.startsWith(revision)) {
        return true;
    }
    if (workingCopyChangeId.length >= minPrefixLen && revision.startsWith(workingCopyChangeId)) {
        return true;
    }
    return false;
}

function inferRootPlatform(root: string, explicitPlatform?: HostPlatform | string): HostPlatform | string {
    if (explicitPlatform !== undefined) {
        return explicitPlatform;
    }
    if (isWindowsStylePath(root) || isWindowsUncSharePath(root) || globalThis.process?.platform === 'win32') {
        return 'win32';
    }
    return globalThis.process?.platform === 'darwin' ? 'darwin' : 'linux';
}

function getUriFsPathForPlatform(uri: Uri, platform?: HostPlatform | string): string {
    if (uri.authority && uri.path.length > 1 && (uri.scheme === 'file' || isJjScheme(uri))) {
        const uncPath = `//${uri.authority}${uri.path}`;
        return isWindowsPlatform(platform) ? uncPath.replace(/\//g, '\\') : uncPath;
    }
    if (isWindowsPlatform(platform)) {
        const fsPath = uri.fsPath;
        return /^\/[a-zA-Z]:(?:$|[/\\])/.test(fsPath) ? fsPath.slice(1) : fsPath;
    }
    return uri.path;
}

export function getFsPathFromUri(uri: Uri, platform?: HostPlatform | string): string {
    const params = getUriParams(uri);
    const targetPath = params.get('path');
    if (targetPath) {
        return pathNormalize(targetPath, platform);
    }
    const root = params.get('root') || params.get('repoRoot');
    if (!root) {
        return getUriFsPathForPlatform(uri, platform);
    }
    const effectivePlatform = inferRootPlatform(root, platform);
    const candidateFsPath = getUriFsPathForPlatform(uri, effectivePlatform);
    const normFsPath = toFsComparisonKey(candidateFsPath, effectivePlatform);
    const normRoot = toFsComparisonKey(root, effectivePlatform);
    const isInsideRoot =
        normFsPath === normRoot || normFsPath.startsWith(normRoot.endsWith('/') ? normRoot : `${normRoot}/`);
    if (isInsideRoot) {
        return candidateFsPath;
    }
    const relativePath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
    return pathResolve([root, relativePath], effectivePlatform);
}

/**
 * Builds a repository file URI under `root` for `file`, `jj-view`, or `jj-edit`
 * schemes, resolving the full filesystem path when `root` is provided so VS Code
 * diff editors compare matching `.path` segments for modified files.
 */
export function createRepoFileUri(
    root: string,
    filePath: string,
    scheme: 'file' | 'jj-view' | 'jj-edit',
    options: { fragment?: string; platform?: HostPlatform | string } = {},
): Uri {
    const { fragment, platform } = options;
    const effectivePlatform = inferRootPlatform(root, platform);
    const cleanPath = stripLeadingSeparators(normalizeRepoSeparators(filePath, effectivePlatform), effectivePlatform);
    if (!root) {
        const relPathStr = cleanPath ? `/${cleanPath}` : '/';
        return Uri.from({
            scheme,
            path: relPathStr,
            fragment,
        });
    }
    const resolvedPath = cleanPath
        ? pathResolve([root, cleanPath], effectivePlatform)
        : pathResolve([root], effectivePlatform);
    if (!isWindowsPlatform(effectivePlatform)) {
        return Uri.from({
            scheme,
            path: resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`,
            fragment: fragment ?? '',
        });
    }
    const baseFileUri = Uri.file(resolvedPath);
    if (scheme === 'file' && !fragment) {
        return baseFileUri;
    }
    return baseFileUri.with({
        scheme,
        fragment: fragment ?? '',
    });
}

export function createDiffUris(
    entry: JjStatusEntry,
    revision: string,
    root: string,
    options: { editable?: boolean; workingCopyChangeId?: string; platform?: HostPlatform | string } = {},
): { leftUri: Uri; rightUri: Uri; resourceUri: Uri } {
    const effectivePlatform = inferRootPlatform(root, options.platform);
    const isCurrentWorkingCopy = isWorkingCopyRevision(revision, options.workingCopyChangeId);

    // For renames/copies, the left side shows the old path
    const leftFilePath =
        (entry.status === 'renamed' || entry.status === 'copied') && entry.oldPath ? entry.oldPath : entry.path;

    const leftUri = createRepoFileUri(root, leftFilePath, 'jj-view', {
        fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'left' }),
        platform: effectivePlatform,
    });

    const resourceParams = new URLSearchParams();
    resourceParams.set('root', root);
    resourceParams.set('jj-revision', revision);
    resourceParams.set('revision', isCurrentWorkingCopy ? '@' : revision);

    const resourceUri = isCurrentWorkingCopy
        ? createRepoFileUri(root, entry.path, 'file', { platform: effectivePlatform })
        : createRepoFileUri(root, entry.path, options.editable ? 'jj-edit' : 'jj-view', {
              fragment: resourceParams.toString(),
              platform: effectivePlatform,
          });

    const isDeleted = entry.status === 'deleted';
    const rightUri =
        !isDeleted && (isCurrentWorkingCopy || options.editable)
            ? resourceUri
            : createRepoFileUri(root, entry.path, 'jj-view', {
                  fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'right' }),
                  platform: effectivePlatform,
              });

    return { leftUri, rightUri, resourceUri };
}

/**
 * Extract a revision ID from a URI query or fragment.
 * Handles jj-revision (SCM resource), revision (jj-edit), and base (jj-view diff).
 */
export function getRevisionFromUri(uri: Uri): string | undefined {
    const params = getUriParams(uri);
    return params.get('jj-revision') || params.get('revision') || params.get('base') || undefined;
}

/**
 * Checks if a URI uses a Jujutsu-specific scheme.
 */
export function isJjScheme(uri: Uri): boolean {
    return uri.scheme === 'jj-view' || uri.scheme === 'jj-edit';
}

function trimTrailingNonRootSlash(normalizedPath: string, platform?: HostPlatform | string): string {
    if (!normalizedPath.endsWith('/') || isFilesystemRootPath(normalizedPath, platform)) {
        return normalizedPath;
    }
    return normalizedPath.slice(0, -1);
}

/**
 * Creates a jj-view URI for viewing a file at a specific revision.
 */
export function createRevisionUri(
    root: string,
    filePath: string,
    revision: string,
    platform?: HostPlatform | string,
): Uri {
    const effectivePlatform = inferRootPlatform(root, platform);
    const normRoot = trimTrailingNonRootSlash(pathNormalize(root, effectivePlatform), effectivePlatform);
    const rootKey = toFsComparisonKey(normRoot, effectivePlatform);
    const rootPrefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
    const normRootPrefix = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;

    let relativePath = filePath;
    if (pathIsAbsolute(filePath, effectivePlatform)) {
        const normFile = trimTrailingNonRootSlash(pathNormalize(filePath, effectivePlatform), effectivePlatform);
        const fileKey = toFsComparisonKey(normFile, effectivePlatform);
        const filePrefix = fileKey.endsWith('/') ? fileKey : `${fileKey}/`;
        if (filePrefix === rootPrefix) {
            relativePath = '';
        } else if (fileKey.startsWith(rootPrefix)) {
            relativePath = normFile.substring(normRootPrefix.length);
        } else {
            relativePath = pathRelative(normRoot, normFile, effectivePlatform);
        }
    }
    const posixRel = normalizeRepoSeparators(relativePath, effectivePlatform);
    return createRepoFileUri(root, posixRel, 'jj-view', {
        fragment: encodeJjViewQuery({ mode: 'revision', root, revision }),
        platform: effectivePlatform,
    });
}

/**
 * Creates a jj-view URI for viewing a file from an uploaded code forge revision/patchset.
 */
export function createUploadedFileUri(
    root: string,
    filePath: string,
    options: {
        changeId: string;
        commitId?: string;
        blobSha?: string;
        remoteRevision?: string;
        changeNumber?: number;
        platform?: HostPlatform | string;
    },
): Uri {
    const effectivePlatform = inferRootPlatform(root, options.platform);
    return createRepoFileUri(root, filePath, 'jj-view', {
        fragment: encodeJjViewQuery({
            mode: 'uploaded',
            root,
            changeId: options.changeId,
            commitId: options.commitId,
            blobSha: options.blobSha,
            remoteRevision: options.remoteRevision,
            changeNumber: options.changeNumber,
        }),
        platform: effectivePlatform,
    });
}

/**
 * Creates a jj-view URI representing fixed text content (e.g. Commit Message diff).
 */
export function createTextContentUri(
    root: string,
    virtualPath: string,
    text: string,
    platform?: HostPlatform | string,
): Uri {
    const effectivePlatform = inferRootPlatform(root, platform);
    const posixRel = normalizeRepoSeparators(virtualPath, effectivePlatform);
    const cleanRel = stripLeadingSeparators(posixRel, effectivePlatform);
    const relPathStr = `/${cleanRel}`;
    return Uri.from({
        scheme: 'jj-view',
        path: relPathStr,
        fragment: encodeJjViewQuery({
            mode: 'text',
            root,
            text,
        }),
    });
}

/**
 * Gets the original resource URI (left side / base) for a file in the workspace or revision.
 */
export function getOriginalResourceUri(root: string, uri: Uri, platform?: HostPlatform | string): Uri {
    const revision = getRevisionFromUri(uri) || '@';
    const relativePath = getRepoRelativePath(uri, root, platform);
    return createRepoFileUri(root, relativePath, 'jj-view', {
        fragment: encodeJjViewQuery({ mode: 'diff', root, base: revision, side: 'left' }),
        platform,
    });
}

function createFileUriForPlatform(fsPath: string, platform?: HostPlatform | string): Uri {
    if (
        platform !== undefined &&
        !isWindowsPlatform(platform) &&
        fsPath.startsWith('/') &&
        !isWindowsUncSharePath(fsPath)
    ) {
        return Uri.from({ scheme: 'file', path: fsPath });
    }
    return Uri.file(fsPath);
}

/**
 * Converts a URI (which may be a custom scheme or contain fragment parameters)
 * into a standard file scheme URI pointing to the underlying workspace file.
 */
export function toFileUri(uri: Uri, platform?: HostPlatform | string): Uri {
    return createFileUriForPlatform(getFsPathFromUri(uri, platform), platform);
}

const canonicalRootCache = new LruCache<string, string>({ maxEntries: 100 });

export type RealpathSyncFn = (filePath: string) => string;
let globalRealpathSync: RealpathSyncFn | undefined;

export function setRealpathSyncResolver(fn: RealpathSyncFn | undefined): void {
    globalRealpathSync = fn;
}

export function clearCanonicalRootCache(): void {
    canonicalRootCache.clear();
}

function getCanonicalRoot(root: string): string {
    let canonical = canonicalRootCache.get(root);
    if (canonical === undefined) {
        try {
            canonical = globalRealpathSync ? globalRealpathSync(root) : root;
        } catch {
            canonical = root;
        }
        canonicalRootCache.set(root, canonical);
    }
    return canonical;
}

/**
 * Normalizes a leading Windows drive letter (`C:/...`, `C:\...`, `C:`) to lowercase
 * so bare drive comparisons (`C:` vs `c:`) and root equality checks match regardless of casing.
 */
export function normalizeDriveLetter(p: string): string {
    return p.replace(/^([a-zA-Z]):(?=[/\\]|$)/, (_, d: string) => `${d.toLowerCase()}:`);
}

/**
 * Checks whether a relative path stays inside its base root (no `..` escape,
 * no absolute path, and no cross-drive / drive-relative Windows prefix).
 */
export function isInsideRelativePath(rel: string, platform?: HostPlatform | string): boolean {
    if (rel === '..' || rel.startsWith('../') || pathIsAbsolute(rel, platform)) {
        return false;
    }
    if (isWindowsPlatform(platform)) {
        return !rel.startsWith('..\\') && !/^[a-zA-Z]:/.test(rel);
    }
    return true;
}

/**
 * Resolves the realpath of `filePath`, climbing up to the nearest existing ancestor
 * directory when the leaf (or intermediate segments) does not exist on disk.
 */
export async function resolveNearestRealPathAsync(
    filePath: string,
    fs: HostFs,
    platform?: HostPlatform | string,
): Promise<string | undefined> {
    const effectivePlatform = platform ?? (isWindowsStylePath(filePath) ? 'win32' : undefined);
    let current = filePath;
    const trailing: string[] = [];
    while (current) {
        try {
            const real = await fs.realpath(current);
            return trailing.length > 0 ? pathJoin([real, ...trailing], effectivePlatform) : real;
        } catch {
            const parent = pathDirname(current, effectivePlatform);
            if (!parent || parent === current || isFilesystemRootPath(current, effectivePlatform)) {
                return undefined;
            }
            trailing.unshift(pathBasename(current, effectivePlatform));
            current = parent;
        }
    }
    return undefined;
}

export type RealRootResolution =
    | { readonly inside: true; readonly relativePath: string }
    | { readonly inside: false; readonly resolvedPath: string };

function classifyResolvedPath(
    resolvedPath: string,
    normRoot: string,
    effectivePlatform?: HostPlatform | string,
): RealRootResolution {
    const target = isWindowsPlatform(effectivePlatform) ? normalizeDriveLetter(resolvedPath) : resolvedPath;
    const rel = pathRelative(normRoot, target, effectivePlatform);
    if (isInsideRelativePath(rel, effectivePlatform)) {
        return { inside: true, relativePath: pathNormalize(rel, effectivePlatform) };
    }
    return { inside: false, resolvedPath };
}

/**
 * Resolves `filePath` against `realRoot` in a single ancestor walk, canonicalizing
 * the parent directory first so tracked leaf symlinks are preserved rather than
 * dereferenced to their targets. Returns `{ inside: true, relativePath }` when
 * inside `realRoot`, `{ inside: false, resolvedPath }` when resolved outside
 * `realRoot`, or `undefined` if no ancestor exists on disk.
 */
export async function resolvePathAgainstRealRootAsync(
    filePath: string,
    realRoot: string,
    fs: HostFs,
    platform?: HostPlatform | string,
): Promise<RealRootResolution | undefined> {
    const effectivePlatform =
        platform ?? (isWindowsStylePath(realRoot) || isWindowsStylePath(filePath) ? 'win32' : undefined);
    const normRoot = isWindowsPlatform(effectivePlatform)
        ? normalizeDriveLetter(pathNormalize(realRoot, effectivePlatform))
        : pathNormalize(realRoot, effectivePlatform);
    const parentDir = pathDirname(filePath, effectivePlatform);
    const isFilesystemRoot = parentDir === filePath || isFilesystemRootPath(filePath, effectivePlatform);

    if (isFilesystemRoot) {
        const rootReal = await resolveNearestRealPathAsync(filePath, fs, effectivePlatform);
        return rootReal === undefined ? undefined : classifyResolvedPath(rootReal, normRoot, effectivePlatform);
    }

    let parentBasedPath: string | undefined;
    const parentReal = await resolveNearestRealPathAsync(parentDir, fs, effectivePlatform);
    if (parentReal !== undefined) {
        parentBasedPath = pathJoin([parentReal, pathBasename(filePath, effectivePlatform)], effectivePlatform);
        const parentResolution = classifyResolvedPath(parentBasedPath, normRoot, effectivePlatform);
        if (parentResolution.inside) {
            return parentResolution;
        }
    }

    let fileReal: string | undefined;
    try {
        fileReal = await fs.realpath(filePath);
    } catch {
        fileReal = parentBasedPath;
    }

    return fileReal === undefined ? undefined : classifyResolvedPath(fileReal, normRoot, effectivePlatform);
}

/**
 * Resolves `filePath` relative to `realRoot` if it falls inside `realRoot`,
 * canonicalizing the parent directory first so tracked leaf symlinks are preserved
 * rather than dereferenced to their targets.
 */
export async function resolveInsideRealRootAsync(
    filePath: string,
    realRoot: string,
    fs: HostFs,
    platform?: HostPlatform | string,
): Promise<string | undefined> {
    const resolution = await resolvePathAgainstRealRootAsync(filePath, realRoot, fs, platform);
    return resolution?.inside ? resolution.relativePath : undefined;
}

function resolveNearestRealPath(fsPath: string, effectivePlatform?: HostPlatform | string): string | undefined {
    if (!globalRealpathSync) {
        return undefined;
    }
    let current = fsPath;
    const trailingSegments: string[] = [];
    while (current) {
        try {
            const canonicalDir = globalRealpathSync(current);
            return trailingSegments.length > 0
                ? pathJoin([canonicalDir, ...trailingSegments], effectivePlatform)
                : canonicalDir;
        } catch {
            const parent = pathDirname(current, effectivePlatform);
            if (!parent || parent === current || isFilesystemRootPath(current, effectivePlatform)) {
                break;
            }
            trailingSegments.unshift(pathBasename(current, effectivePlatform));
            current = parent;
        }
    }
    return undefined;
}

function relativeInsideRoot(
    rootPath: string,
    targetPath: string,
    effectivePlatform: HostPlatform | string,
): string | undefined {
    const normRoot = trimTrailingNonRootSlash(pathNormalize(rootPath, effectivePlatform), effectivePlatform);
    const normTarget = trimTrailingNonRootSlash(pathNormalize(targetPath, effectivePlatform), effectivePlatform);
    const rootKey = toFsComparisonKey(normRoot, effectivePlatform);
    const targetKey = toFsComparisonKey(normTarget, effectivePlatform);
    if (targetKey === rootKey) {
        return '';
    }
    const rootKeyPrefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
    if (targetKey.startsWith(rootKeyPrefix) && normRoot.length === rootKey.length) {
        const normRootPrefix = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
        return normTarget.substring(normRootPrefix.length);
    }
    return undefined;
}

function toLeadingRepoSlash(relativePath: string, effectivePlatform: HostPlatform | string): string {
    const posixRel = normalizeRepoSeparators(relativePath, effectivePlatform);
    return posixRel.startsWith('/') ? posixRel : `/${posixRel}`;
}

/**
 * Gets the relative path of a URI within the repository root.
 * Normalizes leading slash.
 */
export function getRepoRelativePath(uri: Uri, root: string, platform?: HostPlatform | string): string {
    const params = getUriParams(uri);
    const hasEmbeddedRoot = Boolean(params.get('root') || params.get('repoRoot') || params.get('path'));
    const effectiveRoot = root || params.get('root') || params.get('repoRoot') || '';
    if (!effectiveRoot) {
        return uri.path.startsWith('/') ? uri.path : `/${uri.path}`;
    }

    const effectivePlatform = inferRootPlatform(effectiveRoot, platform);
    const isWin = isWindowsPlatform(effectivePlatform);
    const targetFsPath =
        uri.scheme === 'file'
            ? getUriFsPathForPlatform(uri, effectivePlatform)
            : getFsPathFromUri(uri, effectivePlatform);
    const normTargetFsPath = isWin ? normalizeDriveLetter(targetFsPath) : targetFsPath;
    const normRoot = isWin ? normalizeDriveLetter(effectiveRoot) : effectiveRoot;

    const directRel = relativeInsideRoot(normRoot, normTargetFsPath, effectivePlatform);
    if (directRel !== undefined) {
        return toLeadingRepoSlash(directRel, effectivePlatform);
    }
    const relFromRoot = pathRelative(normRoot, normTargetFsPath, effectivePlatform);
    if (isInsideRelativePath(relFromRoot, effectivePlatform)) {
        return toLeadingRepoSlash(relFromRoot, effectivePlatform);
    }

    const rawCanonicalRoot = getCanonicalRoot(effectiveRoot);
    const canonicalRoot = isWin ? normalizeDriveLetter(rawCanonicalRoot) : rawCanonicalRoot;
    const canonicalDirectRel = relativeInsideRoot(canonicalRoot, normTargetFsPath, effectivePlatform);
    if (canonicalDirectRel !== undefined) {
        return toLeadingRepoSlash(canonicalDirectRel, effectivePlatform);
    }
    const relFromCanonical = pathRelative(canonicalRoot, normTargetFsPath, effectivePlatform);
    if (isInsideRelativePath(relFromCanonical, effectivePlatform)) {
        return toLeadingRepoSlash(relFromCanonical, effectivePlatform);
    }

    const nearestCanonical = resolveNearestRealPath(targetFsPath, effectivePlatform);
    if (nearestCanonical) {
        const normNearest = isWin ? normalizeDriveLetter(nearestCanonical) : nearestCanonical;
        const nearestDirectRel = relativeInsideRoot(canonicalRoot, normNearest, effectivePlatform);
        if (nearestDirectRel !== undefined) {
            return toLeadingRepoSlash(nearestDirectRel, effectivePlatform);
        }
        const rel = pathRelative(canonicalRoot, normNearest, effectivePlatform);
        if (isInsideRelativePath(rel, effectivePlatform)) {
            return toLeadingRepoSlash(rel, effectivePlatform);
        }
    }

    if (uri.scheme !== 'file' && !hasEmbeddedRoot) {
        return uri.path.startsWith('/') ? uri.path : `/${uri.path}`;
    }

    if (isInsideRelativePath(relFromCanonical, effectivePlatform)) {
        return toLeadingRepoSlash(relFromCanonical, effectivePlatform);
    }

    return toLeadingRepoSlash(relFromRoot, effectivePlatform);
}

/**
 * Creates a custom editor URI for a commit details view.
 */
export function createCommitDetailsUri(params: { repoRoot: string; changeId: string; title: string }): Uri {
    const fragmentParams = new URLSearchParams();
    fragmentParams.set('changeId', params.changeId);
    fragmentParams.set('repoRoot', params.repoRoot);

    return Uri.from({
        scheme: 'jj-commit',
        authority: 'commit',
        path: `/${params.title}`,
        fragment: fragmentParams.toString(),
    });
}

/**
 * Extracts commit details document information from a custom editor URI.
 */
export function parseCommitDetailsUri(
    uri: Uri,
    platform?: HostPlatform | string,
): { changeId: string; repoRoot?: Uri } {
    const params = getUriParams(uri);
    const changeId = params.get('changeId') || '';
    const repoRootPath = params.get('repoRoot');
    const repoRoot = repoRootPath ? createFileUriForPlatform(repoRootPath, platform) : undefined;
    return { changeId, repoRoot };
}
