/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { JjStatusEntry } from '../../../src/core/jj-types';
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
    fallbackEntry?: JjStatusEntry;
}

function normalizePathSlashes(rawPath: string): string {
    return rawPath
        .replace(/\\/g, '/')
        .replace(/^\/([a-zA-Z]:)/, '$1')
        .replace(/^([a-zA-Z]:)/, (drive) => drive.toLowerCase());
}

function matchesRepoPath(repoRelativePath: string, cleanPath: string, normalizedUriPath: string): boolean {
    const normalizedCandidate = repoRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
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
        fallbackEntry,
    } = params;

    const normPath = rightUri?.path || leftUri?.path || rightUri?.fsPath || leftUri?.fsPath || '';
    const normalizedRoot = normalizePathSlashes(workspaceRoot).replace(/\/+$/, '');
    const normalizedUriPath = normalizePathSlashes(normPath);
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
        if (snapshot?.conflictedPaths.some((p: string) => matchesRepoPath(p, cleanPath, normalizedUriPath))) {
            return createJjResourceState(
                { path: cleanPath, status: 'modified', conflicted: true },
                '@',
                workspaceRoot,
                {
                    openDiffOnClick: true,
                    inConflictGroup: true,
                    workingCopyChangeId: snapshot?.currentEntry?.change_id,
                },
            );
        }
        const change = snapshot?.workingCopyChanges?.find((c: JjStatusEntry) =>
            matchesRepoPath(c.path, cleanPath, normalizedUriPath),
        );
        if (change) {
            return createJjResourceState(change, '@', workspaceRoot, {
                squashable: snapshot?.parentMutable ?? false,
                multipleAncestors: (snapshot?.ancestors.length ?? 0) > 1,
                openDiffOnClick: true,
                hasChild: snapshot?.hasChild ?? false,
                workingCopyChangeId: snapshot?.currentEntry?.change_id,
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
            matchesRepoPath(c.path, cleanPath, normalizedUriPath),
        ) ??
            fallbackEntry ?? { path: cleanPath, status: 'modified' };

        let editable = ancestor.isMutable || rightUri?.scheme === 'jj-edit';
        if (isImmutable !== undefined) {
            editable = !isImmutable;
        }

        return createJjResourceState(change, ancestor.entry.change_id, workspaceRoot, {
            editable,
            squashable: ancestor.canSquash,
            multipleAncestors: remainingAncestors > 0,
            openDiffOnClick: true,
            workingCopyChangeId: snapshot?.currentEntry?.change_id,
        });
    }

    if (rightUri?.scheme === 'jj-edit') {
        return createJjResourceState(fallbackEntry ?? { path: cleanPath, status: 'modified' }, uriRev, workspaceRoot, {
            editable: true,
            openDiffOnClick: true,
            workingCopyChangeId: snapshot?.currentEntry?.change_id,
        });
    }

    return undefined;
}
