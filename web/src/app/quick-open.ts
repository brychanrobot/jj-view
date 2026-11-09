/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'pathe';
import type { HostOpenOptions } from '../../../src/core/host/host-environment';
import type { FuzzyFileMatch } from '../../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../../src/core/host/remote-host-system';
import type { ScmSnapshot } from '../../../src/core/scm-model';
import { Uri } from '../../../src/core/uri-utils';
import type { WebHostEnvironment } from '../host/web-host-environment';
import { scoreFuzzyPath } from '../quick-input/fuzzy-score';
import type { QuickInputService } from '../quick-input/quick-input-service';
import type { TabEntry } from '../tabs/tab-types';

export interface QuickOpenFileItem {
    id: string;
    label: string;
    description?: string;
    detail?: string;
    iconClass: string;
    filterText: string;
    fullPath: string;
    priorityBoost: number;
}

export interface QuickOpenOptions {
    activeQuickInput: QuickInputService;
    workspaceRoot: string;
    currentSnapshot: ScmSnapshot | undefined;
    activeScmSnapshot?: ScmSnapshot;
    tabs: TabEntry[];
    activeTab: TabEntry | undefined;
    remoteHostSystem?: RemoteHostSystem;
    webHostEnv?: WebHostEnvironment;
    loadFileFromUri: (uri: Uri, options?: HostOpenOptions) => Promise<void>;
}

function normalizeQuickOpenPath(rawPath: string): string {
    return path.normalize(rawPath).replace(/^([A-Z]:)/, (drive) => drive.toLowerCase());
}

export function makeQuickOpenItem(
    fullPath: string,
    relPath: string,
    detail: string | undefined,
    priorityBoost: number,
): QuickOpenFileItem {
    const normRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const lastSlash = normRel.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? normRel.slice(lastSlash + 1) : normRel;
    const dirName = lastSlash > 0 ? normRel.slice(0, lastSlash) : undefined;
    return {
        id: normRel || fullPath,
        label: fileName || normRel,
        description: dirName,
        detail,
        iconClass: 'codicon codicon-file',
        filterText: normRel,
        fullPath,
        priorityBoost,
    };
}

export function collectPrioritizedQuickOpenFiles(
    searchRoot: string,
    repoRoot: string,
    currentSnapshot: ScmSnapshot | undefined,
    orderedTabs: TabEntry[],
    activeTab: TabEntry | undefined,
): QuickOpenFileItem[] {
    const items: QuickOpenFileItem[] = [];
    const byFullPath = new Map<string, QuickOpenFileItem>();
    const normalizedSearchRoot = normalizeQuickOpenPath(searchRoot);

    const toRelative = (fullPath: string): string | null => {
        const rel = path.relative(normalizedSearchRoot, normalizeQuickOpenPath(fullPath));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            return null;
        }
        return rel.replace(/\\/g, '/');
    };

    const modifiedStatusByFullPath = new Map<string, string>();
    const effectiveRepoRoot = normalizeQuickOpenPath(repoRoot || searchRoot);
    const snap = currentSnapshot;
    if (snap?.conflictedPaths) {
        for (const p of snap.conflictedPaths) {
            const full = normalizeQuickOpenPath(path.join(effectiveRepoRoot, p));
            modifiedStatusByFullPath.set(full, 'Conflicted');
        }
    }
    if (snap?.workingCopyChanges) {
        for (const c of snap.workingCopyChanges) {
            if (c.status === 'deleted') {
                continue;
            }
            const full = normalizeQuickOpenPath(path.join(effectiveRepoRoot, c.path));
            if (!modifiedStatusByFullPath.has(full)) {
                modifiedStatusByFullPath.set(full, c.status === 'added' ? 'Added' : 'Modified');
            }
        }
    }

    // 1. Open tabs (active tab first, then remaining tabs)
    const tabsOrder = activeTab ? [activeTab, ...orderedTabs.filter((t) => t.id !== activeTab.id)] : [...orderedTabs];
    for (const t of tabsOrder) {
        let fullPath: string | undefined;
        if ((t.view.type === 'file' || t.view.type === 'merge') && t.view.uri.scheme === 'file') {
            fullPath = normalizeQuickOpenPath(t.view.uri.fsPath);
        } else if (t.view.type === 'diff') {
            if (t.view.rightUri?.scheme === 'file') {
                fullPath = normalizeQuickOpenPath(t.view.rightUri.fsPath);
            } else if (t.view.resourceState?.relativePath) {
                fullPath = normalizeQuickOpenPath(path.join(effectiveRepoRoot, t.view.resourceState.relativePath));
            }
        }
        if (!fullPath || byFullPath.has(fullPath)) {
            continue;
        }
        const rel = toRelative(fullPath);
        if (!rel) {
            continue;
        }
        const modBadge = modifiedStatusByFullPath.get(fullPath);
        const detail = modBadge ? `Open • ${modBadge}` : 'Open';
        const entry = makeQuickOpenItem(fullPath, rel, detail, 6000);
        byFullPath.set(fullPath, entry);
        items.push(entry);
    }

    // 2. Working-copy modified / added / conflicted files
    for (const [fullPath, statusLabel] of modifiedStatusByFullPath.entries()) {
        if (byFullPath.has(fullPath)) {
            continue;
        }
        const rel = toRelative(fullPath);
        if (!rel) {
            continue;
        }
        const entry = makeQuickOpenItem(fullPath, rel, statusLabel, 4000);
        byFullPath.set(fullPath, entry);
        items.push(entry);
    }

    return items;
}

export function mergeQuickOpenItems(
    query: string,
    prioritized: readonly QuickOpenFileItem[],
    workspaceMatches: readonly FuzzyFileMatch[],
): QuickOpenFileItem[] {
    const trimmed = query.trim();
    if (!trimmed) {
        const seen = new Set<string>();
        const merged: QuickOpenFileItem[] = [];
        for (const p of prioritized) {
            seen.add(normalizeQuickOpenPath(p.fullPath));
            merged.push(p);
        }
        for (const m of workspaceMatches) {
            const normMatchPath = normalizeQuickOpenPath(m.path);
            if (seen.has(normMatchPath)) {
                continue;
            }
            seen.add(normMatchPath);
            merged.push(makeQuickOpenItem(m.path, m.relPath, undefined, 0));
        }
        return merged;
    }

    const scoredMap = new Map<string, { item: QuickOpenFileItem; score: number }>();

    for (const p of prioritized) {
        const s = scoreFuzzyPath(p.filterText, trimmed);
        if (s !== null) {
            scoredMap.set(normalizeQuickOpenPath(p.fullPath), { item: p, score: s + p.priorityBoost });
        }
    }

    for (const m of workspaceMatches) {
        const normMatchPath = normalizeQuickOpenPath(m.path);
        const existing = scoredMap.get(normMatchPath);
        if (existing) {
            const boosted = m.score + existing.item.priorityBoost;
            if (boosted > existing.score) {
                existing.score = boosted;
            }
            continue;
        }
        scoredMap.set(normMatchPath, {
            item: makeQuickOpenItem(m.path, m.relPath, undefined, 0),
            score: m.score,
        });
    }

    return Array.from(scoredMap.values())
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            if (b.item.priorityBoost !== a.item.priorityBoost) {
                return b.item.priorityBoost - a.item.priorityBoost;
            }
            return a.item.filterText.localeCompare(b.item.filterText);
        })
        .map((e) => e.item);
}

export async function openQuickOpen(options: QuickOpenOptions): Promise<void> {
    const {
        activeQuickInput,
        workspaceRoot,
        currentSnapshot,
        activeScmSnapshot,
        tabs,
        activeTab,
        remoteHostSystem: host,
        webHostEnv,
        loadFileFromUri,
    } = options;

    const snap = currentSnapshot ?? activeScmSnapshot;
    const searchRoot = workspaceRoot || webHostEnv?.workspace.workspaceFolders[0]?.uri.fsPath || host?.repoRoot || '';
    const searchRootUri = searchRoot ? Uri.file(searchRoot) : undefined;
    const initialPrioritized = searchRoot
        ? collectPrioritizedQuickOpenFiles(searchRoot, workspaceRoot, snap, tabs, activeTab)
        : [];

    if (searchRoot && host && searchRoot !== host.repoRoot) {
        void host.addAllowedRoot(searchRoot).catch(() => {});
    }

    let latestRequestId = 0;
    const abortHolder: { current: AbortController | null } = { current: null };
    let pickerClosed = false;

    const triggerBackendSearch = async (query: string): Promise<void> => {
        if (!webHostEnv && !host) {
            return;
        }
        const reqId = ++latestRequestId;
        const prev = abortHolder.current;
        if (prev) {
            prev.abort();
        }
        const controller = new AbortController();
        abortHolder.current = controller;

        try {
            let matches: FuzzyFileMatch[] = [];
            if (webHostEnv) {
                matches = await webHostEnv.workspace.fuzzyFindFiles(query, searchRootUri, 100, controller.signal);
            } else if (host && searchRoot) {
                matches = await host.fuzzyFindFiles(query, searchRoot, 100, undefined, controller.signal);
            }
            if (pickerClosed || reqId !== latestRequestId) {
                return;
            }
            const livePrioritized = searchRoot
                ? collectPrioritizedQuickOpenFiles(searchRoot, workspaceRoot, snap, tabs, activeTab)
                : initialPrioritized;
            const merged = mergeQuickOpenItems(query, livePrioritized, matches);
            activeQuickInput.updateQuickPickItems(merged);
        } catch (err) {
            if (!controller.signal.aborted) {
                console.warn('[QuickOpen] Backend fuzzy search failed:', err);
            }
        }
    };

    const pickPromise = activeQuickInput.showQuickPick(initialPrioritized, {
        title: 'Go to File',
        placeHolder: 'Search files by name (append space to match path segments)...',
        matchOnDescription: true,
        preserveOrder: true,
        onDidChangeValue: (val) => {
            void triggerBackendSearch(val);
        },
    });

    void triggerBackendSearch('');

    const selected = await pickPromise;
    pickerClosed = true;
    const cur = abortHolder.current;
    if (cur) {
        cur.abort();
        abortHolder.current = null;
    }

    if (selected?.fullPath) {
        await loadFileFromUri(Uri.file(selected.fullPath), { preview: false });
    }
}
