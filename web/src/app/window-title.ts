/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HostPlatform } from '../../../src/core/host/host-system';
import {
    isFilesystemRootPath,
    isWindowsPlatform,
    isWindowsStylePath,
    isWindowsUncSharePath,
    pathBasename,
    toFsComparisonKey,
} from '../../../src/core/path-utils';
import { formatRepositoryDisplayNames } from '../scm/scm-repo-types';

export interface WindowTitleOptions {
    readonly activeTabTitle?: string;
    readonly activeTabDirty?: boolean;
    readonly focusedRepoRoot?: string;
    readonly repositoryRoots?: readonly string[];
    readonly platform?: HostPlatform | string;
}

const TITLE_APP_NAME = 'JJ View';
const TITLE_SEPARATOR = ' \u2014 ';

function formatRepoLabel(
    focusedRepoRoot?: string,
    repositoryRoots?: readonly string[],
    platform?: HostPlatform | string,
): string {
    const trimmed = focusedRepoRoot?.trim();
    if (!trimmed || trimmed === '.') {
        return '';
    }
    const effectivePlatform =
        platform ?? (isWindowsStylePath(trimmed) || isWindowsUncSharePath(trimmed) ? 'win32' : undefined);
    if (isFilesystemRootPath(trimmed, effectivePlatform)) {
        return '';
    }
    if (repositoryRoots && repositoryRoots.length > 1) {
        const stripTrailing = (p: string): string => {
            if (isFilesystemRootPath(p, effectivePlatform)) {
                return p;
            }
            return isWindowsPlatform(effectivePlatform) ? p.replace(/[/\\]+$/, '') : p.replace(/\/+$/, '');
        };
        const targetKey = toFsComparisonKey(stripTrailing(trimmed), effectivePlatform);
        const matchedRoot =
            repositoryRoots.find((r) => r === focusedRepoRoot) ??
            repositoryRoots.find((r) => toFsComparisonKey(stripTrailing(r.trim()), effectivePlatform) === targetKey);
        if (matchedRoot) {
            const display = formatRepositoryDisplayNames(repositoryRoots, effectivePlatform).get(matchedRoot);
            if (display) {
                return display.qualifier ? `${display.qualifier}/${display.name}` : display.name;
            }
        }
    }
    const base = pathBasename(trimmed, effectivePlatform);
    if (!base || base === '.' || base === '..' || base === '/' || base === '\\') {
        return '';
    }
    return base;
}

function formatTabLabel(activeTabTitle?: string, activeTabDirty?: boolean): string {
    const trimmed = activeTabTitle?.trim();
    if (!trimmed) {
        return '';
    }
    return activeTabDirty ? `\u25cf ${trimmed}` : trimmed;
}

export function formatWindowTitle(options: WindowTitleOptions): string {
    const parts: string[] = [];
    const tabLabel = formatTabLabel(options.activeTabTitle, options.activeTabDirty);
    if (tabLabel) {
        parts.push(tabLabel);
    }
    const repoLabel = formatRepoLabel(options.focusedRepoRoot, options.repositoryRoots, options.platform);
    if (repoLabel) {
        parts.push(repoLabel);
    }
    parts.push(TITLE_APP_NAME);
    return parts.join(TITLE_SEPARATOR);
}
