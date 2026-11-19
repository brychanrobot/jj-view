/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { HostPlatform } from '../../../src/core/host/host-system';
import type { JjStatusEntry } from '../../../src/core/jj-types';
import {
    isWindowsStylePath,
    normalizeRepoSeparators,
    normalizeSeparatorsForHost,
    stripLeadingSeparators,
} from '../../../src/core/path-utils';
import type { ScmSnapshot } from '../../../src/core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../../src/core/scm-resource-state';
import { getRevisionFromUri, isWorkingCopyRevision, type Uri } from '../../../src/core/uri-utils';

export interface ResolveScmResourceParams {
    leftUri?: Uri;
    rightUri?: Uri;
    snapshot?: ScmSnapshot;
    workspaceRoot: string;
    explicitRevision?: string;
    isWorkingCopyOverride?: boolean;
    isImmutable?: boolean;
    editableMutableDiffs?: boolean;
    fallbackEntry?: JjStatusEntry;
    platform?: HostPlatform | string;
}

function normalizePathSlashes(rawPath: string, platform?: HostPlatform | string): string {
    return normalizeSeparatorsForHost(rawPath, platform)
        .replace(/^\/([a-zA-Z]:)/, '$1')
        .replace(/^([a-zA-Z]:)/, (drive) => drive.toLowerCase());
}

function matchesRepoPath(
    repoRelativePath: string,
    cleanPath: string,
    normalizedUriPath: string,
    platform?: HostPlatform | string,
): boolean {
    const normalizedCandidate = stripLeadingSeparators(normalizeRepoSeparators(repoRelativePath, platform), platform);
    return normalizedCandidate === cleanPath || normalizedUriPath.endsWith(`/${normalizedCandidate}`);
}

/**
 * Resolves a JjResourceState from diff URIs and snapshot state, matching
 * working copy changes, ancestor changes, or jj-edit schemes.
 */
export function resolveScmResourceState(params: ResolveScmResourceParams): JjResourceState | undefined {
    const {
        leftUri,
        rightUri,
        snapshot,
        workspaceRoot,
        explicitRevision,
        isWorkingCopyOverride,
        isImmutable,
        editableMutableDiffs,
        fallbackEntry,
        platform,
    } = params;

    const effectivePlatform = platform ?? (isWindowsStylePath(workspaceRoot) ? 'win32' : undefined);
    const normPath = rightUri?.path || leftUri?.path || rightUri?.fsPath || leftUri?.fsPath || '';
    const normalizedRoot = normalizePathSlashes(workspaceRoot, effectivePlatform).replace(/\/+$/, '');
    const normalizedUriPath = normalizePathSlashes(normPath, effectivePlatform);
    const cleanPath =
        normalizedRoot && normalizedUriPath.startsWith(`${normalizedRoot}/`)
            ? normalizedUriPath.slice(normalizedRoot.length + 1)
            : normalizedUriPath.startsWith('/')
              ? normalizedUriPath.slice(1)
              : normalizedUriPath;

    const uriRev =
        explicitRevision ??
        (rightUri?.scheme === 'file'
            ? '@'
            : (rightUri && getRevisionFromUri(rightUri)) || (leftUri && getRevisionFromUri(leftUri)) || '@');

    const isWc = isWorkingCopyOverride ?? isWorkingCopyRevision(uriRev, snapshot?.currentEntry?.change_id);

    if (isWc) {
        if (
            snapshot?.conflictedPaths.some((p: string) =>
                matchesRepoPath(p, cleanPath, normalizedUriPath, effectivePlatform),
            )
        ) {
            return createJjResourceState(
                { path: cleanPath, status: 'modified', conflicted: true },
                '@',
                workspaceRoot,
                {
                    openDiffOnClick: true,
                    inConflictGroup: true,
                    workingCopyChangeId: snapshot?.currentEntry?.change_id,
                    mutableCommit: !(snapshot?.currentEntry?.is_immutable ?? false),
                    platform: effectivePlatform,
                },
            );
        }
        const change = snapshot?.workingCopyChanges?.find((c: JjStatusEntry) =>
            matchesRepoPath(c.path, cleanPath, normalizedUriPath, effectivePlatform),
        );
        if (change) {
            return createJjResourceState(change, '@', workspaceRoot, {
                squashable: snapshot?.parentMutable ?? false,
                multipleAncestors: (snapshot?.ancestors.length ?? 0) > 1,
                openDiffOnClick: true,
                hasChild: snapshot?.hasChild ?? false,
                workingCopyChangeId: snapshot?.currentEntry?.change_id,
                mutableCommit: !(snapshot?.currentEntry?.is_immutable ?? false),
                platform: effectivePlatform,
            });
        }
        return undefined;
    }

    const ancestorIdx =
        uriRev.length > 0
            ? (snapshot?.ancestors.findIndex(
                  (a) =>
                      a.entry.change_id === uriRev ||
                      a.entry.change_id.startsWith(uriRev) ||
                      uriRev.startsWith(a.entry.change_id),
              ) ?? -1)
            : -1;

    if (ancestorIdx >= 0 && snapshot?.ancestors[ancestorIdx]) {
        const ancestor = snapshot.ancestors[ancestorIdx];
        const remainingAncestors = snapshot.ancestors.length - 1 - ancestorIdx;
        const change: JjStatusEntry = ancestor.changes.find((c: JjStatusEntry) =>
            matchesRepoPath(c.path, cleanPath, normalizedUriPath, effectivePlatform),
        ) ??
            fallbackEntry ?? { path: cleanPath, status: 'modified' };

        const allowEditableMutableDiffs = editableMutableDiffs ?? true;
        const isCommitMutable = isImmutable !== undefined ? !isImmutable : ancestor.isMutable;
        const editable = (isCommitMutable && allowEditableMutableDiffs) || rightUri?.scheme === 'jj-edit';

        return createJjResourceState(change, ancestor.entry.change_id, workspaceRoot, {
            editable,
            squashable: ancestor.canSquash,
            multipleAncestors: remainingAncestors > 0,
            openDiffOnClick: true,
            workingCopyChangeId: snapshot?.currentEntry?.change_id,
            mutableCommit: isCommitMutable,
            platform: effectivePlatform,
        });
    }

    if (rightUri?.scheme === 'jj-edit') {
        return createJjResourceState(fallbackEntry ?? { path: cleanPath, status: 'modified' }, uriRev, workspaceRoot, {
            editable: true,
            openDiffOnClick: true,
            workingCopyChangeId: snapshot?.currentEntry?.change_id,
            platform: effectivePlatform,
        });
    }

    return undefined;
}
