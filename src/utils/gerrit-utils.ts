/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Matches standard Gerrit Change-Id trailer (e.g. Change-Id: Iabcdef1234567890abcdef1234567890abcdef12)
const CHANGE_ID_TRAILER_REGEX = /^Change-Id: (I[0-9a-fA-F]{40})\s*$/m;

// Matches Gerrit Link trailer containing "/+/" change number structure (e.g. Link: https://host.com/c/proj/+/123)
const LINK_TRAILER_PLUS_REGEX = /^Link: (.*\/\+\/(\d+)(?:\/\d+)?\/?)\s*$/m;

// Matches Gerrit Link trailer pointing to the change number directly (e.g. Link: https://host.com/123)
const LINK_TRAILER_DIRECT_REGEX = /^Link: (.*\/(\d+)\/?)\s*$/m;

/**
 * Extracts a Gerrit change number or Change-Id from a commit message description
 * and checks if the URL matches the expected Gerrit host.
 *
 * @param description The commit message description.
 * @param gerritHost The configured Gerrit host (e.g. 'https://gerrit-review.googlesource.com').
 * @returns The resolved change number (e.g. '12345') or Change-Id (e.g. 'Iabc...'), or undefined.
 */
export function resolveGerritChangeKey(description: string, gerritHost?: string): string | undefined {
    // 1. Try to extract standard Gerrit Change-Id trailer
    const changeIdMatch = description.match(CHANGE_ID_TRAILER_REGEX);
    if (changeIdMatch) {
        return changeIdMatch[1];
    }

    // 2. Try to extract Gerrit Link trailer URLs
    // Matches formats like Link: https://host.com/c/proj/+/12345 or Link: https://host.com/12345
    const linkMatch1 = description.match(LINK_TRAILER_PLUS_REGEX);
    const linkMatch2 = description.match(LINK_TRAILER_DIRECT_REGEX);
    const linkMatch = linkMatch1 || linkMatch2;

    if (linkMatch && gerritHost) {
        const urlStr = linkMatch[1];
        const changeNum = linkMatch[2];
        if (changeNum && isMatchingGerritHost(urlStr, gerritHost)) {
            return changeNum;
        }
    }

    return undefined;
}

function isMatchingGerritHost(urlStr: string, gerritHost: string): boolean {
    try {
        const expectedHost = new URL(gerritHost).hostname.toLowerCase();
        const urlObj = new URL(urlStr);
        return urlObj.hostname.toLowerCase() === expectedHost;
    } catch {
        // Fallback if URL parsing fails
        return urlStr.includes(gerritHost);
    }
}

/**
 * Removes Gerrit Change-Id and Link trailers from a commit description.
 */
export function stripGerritTrailers(description: string): string {
    return description
        .replace(new RegExp(CHANGE_ID_TRAILER_REGEX.source, 'gm'), '')
        .replace(new RegExp(LINK_TRAILER_PLUS_REGEX.source, 'gm'), '')
        .replace(new RegExp(LINK_TRAILER_DIRECT_REGEX.source, 'gm'), '')
        .trim();
}
