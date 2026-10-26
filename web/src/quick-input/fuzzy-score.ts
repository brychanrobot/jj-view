/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QuickPickItem } from './quick-input-types';

function isWordBoundary(target: string, index: number, baseOffset = 0): boolean {
    if (index === 0 || index === baseOffset) {
        return true;
    }
    const prev = target.charCodeAt(index - 1);
    // '/', '_', '-', '.', ' ', ':'
    if (prev === 47 || prev === 95 || prev === 45 || prev === 46 || prev === 32 || prev === 58) {
        return true;
    }
    const curr = target.charCodeAt(index);
    // camelCase transition: a-z followed by A-Z
    return prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90;
}

function charPositionBonus(target: string, index: number, baseOffset: number, exactCase: boolean): number {
    let bonus = index >= baseOffset ? 100 : 30;
    if (exactCase) {
        bonus += 15;
    }
    if (index === baseOffset) {
        return bonus + 600;
    }
    if (index === 0) {
        return bonus + 150;
    }
    const prev = target.charCodeAt(index - 1);
    const curr = target.charCodeAt(index);
    if (prev === 47) {
        return bonus + 140;
    }
    if (prev === 95 || prev === 45 || prev === 46 || prev === 32 || prev === 58) {
        return bonus + (index > baseOffset ? 300 : 90);
    }
    if (prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90) {
        return bonus + (index > baseOffset ? 280 : 80);
    }
    return bonus;
}

/**
 * Computes a VS Code-style fuzzy alignment score of `query` within `target`.
 * Returns `null` if `query` is not a subsequence of `target`.
 */
export function scoreFuzzyString(target: string, query: string, baseOffset = 0, isBasenameOnly = true): number | null {
    const qLower = query.toLowerCase();
    const tLower = target.toLowerCase();
    const m = qLower.length;
    const n = target.length;
    if (m === 0) {
        return 0;
    }
    if (m > n) {
        return null;
    }

    if (isBasenameOnly && n === m) {
        if (tLower !== qLower) {
            return null;
        }
        return 50000 + m * 300 + (target === query ? 500 : 0);
    }

    let qi = 0;
    let firstMatch = -1;
    for (let ti = 0; ti < n && qi < m; ti++) {
        if (tLower.charCodeAt(ti) === qLower.charCodeAt(qi)) {
            if (qi === 0) {
                firstMatch = ti;
            }
            qi++;
        }
    }
    if (qi < m) {
        return null;
    }

    qi = m - 1;
    let lastMatch = -1;
    for (let ti = n - 1; ti >= firstMatch && qi >= 0; ti--) {
        if (tLower.charCodeAt(ti) === qLower.charCodeAt(qi)) {
            if (qi === m - 1) {
                lastMatch = ti;
            }
            qi--;
        }
    }

    const spanLen = lastMatch - firstMatch + 1;
    const negInf = -1_000_000_000;
    const gapPenalty = 8;

    const prevM = new Int32Array(spanLen);
    const currM = new Int32Array(spanLen);

    const maxJ0 = lastMatch - (m - 1);
    for (let j = firstMatch; j <= lastMatch; j++) {
        const idx = j - firstMatch;
        if (j <= maxJ0 && tLower.charCodeAt(j) === qLower.charCodeAt(0)) {
            let b =
                charPositionBonus(target, j, baseOffset, target.charCodeAt(j) === query.charCodeAt(0)) -
                (j - baseOffset) * 3;
            if (!isWordBoundary(target, j, baseOffset)) {
                b -= 260;
            }
            prevM[idx] = b;
        } else {
            prevM[idx] = negInf;
        }
    }

    for (let i = 1; i < m; i++) {
        const qCharLow = qLower.charCodeAt(i);
        const qCharRaw = query.charCodeAt(i);
        const minJ = firstMatch + i;
        const maxJ = lastMatch - (m - 1 - i);

        let bestGapScore = negInf;
        currM[minJ - 1 - firstMatch] = negInf;

        for (let j = minJ; j <= maxJ; j++) {
            const idx = j - firstMatch;
            const prevAtJMinus1 = prevM[idx - 1];

            if (tLower.charCodeAt(j) === qCharLow) {
                const posBonus = charPositionBonus(target, j, baseOffset, target.charCodeAt(j) === qCharRaw);
                let bestHere = negInf;

                if (prevAtJMinus1 > negInf / 2) {
                    const consecBonus = j > baseOffset ? 180 : 90;
                    bestHere = prevAtJMinus1 + posBonus + consecBonus;
                }
                if (bestGapScore > negInf / 2) {
                    let gapCandidate = bestGapScore + posBonus;
                    if (!isWordBoundary(target, j, baseOffset)) {
                        gapCandidate -= 260;
                    }
                    if (gapCandidate > bestHere) {
                        bestHere = gapCandidate;
                    }
                }
                currM[idx] = bestHere;
            } else {
                currM[idx] = negInf;
            }

            if (prevAtJMinus1 > bestGapScore) {
                bestGapScore = prevAtJMinus1;
            }
            if (bestGapScore > negInf / 2) {
                bestGapScore -= gapPenalty;
            }
        }

        for (let j = minJ; j <= maxJ; j++) {
            const idx = j - firstMatch;
            prevM[idx] = currM[idx];
        }
    }

    let bestScore = negInf;
    const minLastJ = firstMatch + m - 1;
    for (let j = minLastJ; j <= lastMatch; j++) {
        const s = prevM[j - firstMatch];
        if (s > bestScore) {
            bestScore = s;
        }
    }

    if (isBasenameOnly) {
        bestScore += 4000 - (n - m) * 15;
        const subPos = tLower.indexOf(qLower);
        if (subPos === 0) {
            bestScore += 20000;
        } else if (subPos > 0 && isWordBoundary(target, subPos, 0)) {
            bestScore += 12000;
        }
    }

    return bestScore;
}

/**
 * Scores a relative file path against a potentially multi-token query, matching
 * the Go `FuzzyFindFiles` scoring rules.
 */
export function scoreFuzzyPath(relPath: string, query: string): number | null {
    const normPath = relPath.replace(/\\/g, '/');
    const lastSlash = normPath.lastIndexOf('/');
    const baseOffset = lastSlash + 1;
    const basename = normPath.slice(baseOffset);
    const dirPart = lastSlash > 0 ? normPath.slice(0, lastSlash) : '';
    const dirLower = dirPart.toLowerCase();

    const rawTokens = query
        .trim()
        .split(/\s+/)
        .map((t) =>
            t
                .replace(/\\/g, '/')
                .replace(/^\.\//, '')
                .replace(/^\/+|\/+$/g, ''),
        )
        .filter((t) => t.length > 0);

    if (rawTokens.length === 0) {
        return 0;
    }

    let total = 0;
    for (const tok of rawTokens) {
        const tokLower = tok.toLowerCase();
        if (!tok.includes('/')) {
            const baseScore = scoreFuzzyString(basename, tok, 0, true);
            if (baseScore !== null) {
                total += baseScore;
                continue;
            }
            if (dirLower.length > 0) {
                const pos = dirLower.indexOf(tokLower);
                if (pos >= 0) {
                    let dirScore = 1200 + tokLower.length * 60;
                    if (pos === 0 || dirLower.charCodeAt(pos - 1) === 47) {
                        dirScore += 500;
                    }
                    const end = pos + tokLower.length;
                    if (end === dirLower.length || dirLower.charCodeAt(end) === 47) {
                        dirScore += 500;
                    }
                    total += dirScore;
                    continue;
                }
            }
            return null;
        }

        const tokLastSlash = tok.lastIndexOf('/');
        const suffixRaw = tok.slice(tokLastSlash + 1);
        const suffixLow = suffixRaw.toLowerCase();
        if (suffixRaw.length > 0) {
            if (scoreFuzzyString(basename, suffixRaw, 0, true) === null) {
                return null;
            }
        }
        let pathScore = scoreFuzzyString(normPath, tok, baseOffset, false);
        if (pathScore === null) {
            return null;
        }
        if (suffixLow.length > 0) {
            const baseLower = basename.toLowerCase();
            if (baseLower === suffixLow) {
                pathScore += 40000;
            } else if (baseLower.includes(suffixLow)) {
                pathScore += 12000;
            }
        }
        total += pathScore;
    }

    let depth = 0;
    for (let i = 0; i < normPath.length; i++) {
        if (normPath.charCodeAt(i) === 47) {
            depth++;
        }
    }
    return total - normPath.length * 2 - depth * 15;
}

export function filterAndScoreQuickPickItems<T>(
    items: readonly QuickPickItem<T>[],
    query: string,
    options: {
        matchOnDescription?: boolean;
        matchOnDetail?: boolean;
        preserveOrder?: boolean;
    } = {},
): QuickPickItem<T>[] {
    const trimmed = query.trim();
    if (!trimmed) {
        return [...items];
    }

    const scored: { item: QuickPickItem<T>; score: number; index: number }[] = [];

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.alwaysShow) {
            scored.push({ item: it, score: 1_000_000, index: i });
            continue;
        }

        if (it.filterText) {
            const pathScore = scoreFuzzyPath(it.filterText, trimmed);
            if (pathScore !== null) {
                scored.push({ item: it, score: pathScore, index: i });
                continue;
            }
        }

        const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
        let allMatched = true;
        let combinedScore = 0;

        for (const tok of tokens) {
            const labelScore = scoreFuzzyString(it.label, tok, 0, true);
            let bestTokenScore = labelScore;

            if (options.matchOnDescription && it.description) {
                const descScore = scoreFuzzyString(it.description, tok, 0, false);
                if (descScore !== null && (bestTokenScore === null || descScore > bestTokenScore)) {
                    bestTokenScore = descScore;
                }
            }
            if (options.matchOnDetail && it.detail) {
                const detailScore = scoreFuzzyString(it.detail, tok, 0, false);
                if (detailScore !== null && (bestTokenScore === null || detailScore > bestTokenScore)) {
                    bestTokenScore = detailScore;
                }
            }

            if (bestTokenScore === null) {
                allMatched = false;
                break;
            }
            combinedScore += bestTokenScore;
        }

        if (allMatched) {
            scored.push({ item: it, score: combinedScore, index: i });
        }
    }

    if (!options.preserveOrder) {
        scored.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return a.index - b.index;
        });
    }

    return scored.map((entry) => entry.item);
}
