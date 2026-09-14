/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JjLogEntry } from '../../../jj-types';
import { getPersonDisplayStrings } from '../../common/utils/person-utils';

/**
 * Converts alphanumeric characters to Mathematical Sans-Serif Bold Unicode glyphs.
 * Non-alphanumeric characters remain untouched.
 */
export function toUnicodeBold(text: string): string {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 65 && code <= 90) {
            // A-Z
            result += String.fromCodePoint(0x1d5d4 + (code - 65));
        } else if (code >= 97 && code <= 122) {
            // a-z
            result += String.fromCodePoint(0x1d5ee + (code - 97));
        } else if (code >= 48 && code <= 57) {
            // 0-9
            result += String.fromCodePoint(0x1d7ec + (code - 48));
        } else {
            result += text[i];
        }
    }
    return result;
}

/**
 * Converts Mathematical Sans-Serif Bold Unicode glyphs back to standard ASCII characters.
 */
export function fromUnicodeBold(text: string): string {
    let result = '';
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x1d5d4 && code <= 0x1d5ed) {
            // A-Z
            result += String.fromCharCode(65 + (code - 0x1d5d4));
        } else if (code >= 0x1d5ee && code <= 0x1d607) {
            // a-z
            result += String.fromCharCode(97 + (code - 0x1d5ee));
        } else if (code >= 0x1d7ec && code <= 0x1d7f5) {
            // 0-9
            result += String.fromCharCode(48 + (code - 0x1d7ec));
        } else {
            result += char;
        }
    }
    return result;
}

/**
 * Converts alphanumeric characters to Mathematical Monospace Unicode glyphs.
 * Non-alphanumeric characters remain untouched.
 */
export function toUnicodeMonospace(text: string): string {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 65 && code <= 90) {
            // A-Z
            result += String.fromCodePoint(0x1d670 + (code - 65));
        } else if (code >= 97 && code <= 122) {
            // a-z
            result += String.fromCodePoint(0x1d68a + (code - 97));
        } else if (code >= 48 && code <= 57) {
            // 0-9
            result += String.fromCodePoint(0x1d7f6 + (code - 48));
        } else {
            result += text[i];
        }
    }
    return result;
}

/**
 * Converts Mathematical Monospace Unicode glyphs back to standard ASCII characters.
 */
export function fromUnicodeMonospace(text: string): string {
    let result = '';
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x1d670 && code <= 0x1d689) {
            // A-Z
            result += String.fromCharCode(65 + (code - 0x1d670));
        } else if (code >= 0x1d68a && code <= 0x1d6a3) {
            // a-z
            result += String.fromCharCode(97 + (code - 0x1d68a));
        } else if (code >= 0x1d7f6 && code <= 0x1d7ff) {
            // 0-9
            result += String.fromCharCode(48 + (code - 0x1d7f6));
        } else {
            result += char;
        }
    }
    return result;
}

const DIVIDER = '────────────────────────────────────────';

/**
 * Formats a rich, multi-line native title tooltip for a JJ commit revision.
 * Uses small caps labels, bold shortest change ID prefix, monospace hashes,
 * relative timestamps, and dividers.
 */
export function formatCommitTooltip(commit: JjLogEntry): string {
    const lines: string[] = [];

    // Header: Change ID and Badges
    const badges: string[] = [];
    if (commit.is_current_working_copy) {
        badges.push('@ (working copy)');
    }
    if (commit.is_empty) {
        badges.push('(empty)');
    }
    if (commit.conflict) {
        badges.push('⚠️ (conflict)');
    }
    if (commit.is_divergent) {
        badges.push('⑂ (divergent)');
    }
    if (commit.is_immutable) {
        badges.push('🔒 (immutable)');
    }

    const HASH_DISPLAY_LENGTH = 10;

    const truncatedChangeId = commit.change_id.slice(0, HASH_DISPLAY_LENGTH);
    let formattedChangeId = toUnicodeMonospace(truncatedChangeId);
    if (commit.change_id_shortest && commit.change_id.startsWith(commit.change_id_shortest)) {
        const prefix = commit.change_id_shortest;
        if (prefix.length < truncatedChangeId.length) {
            const rest = truncatedChangeId.slice(prefix.length);
            formattedChangeId = `${toUnicodeBold(prefix)}${toUnicodeMonospace(rest)}`;
        } else {
            formattedChangeId = toUnicodeBold(truncatedChangeId);
        }
    }
    lines.push(`ᴄʜᴀɴɢᴇ: ${formattedChangeId}`);

    // Commit ID
    const truncatedCommitId = commit.commit_id.slice(0, HASH_DISPLAY_LENGTH);
    lines.push(`ᴄᴏᴍᴍɪᴛ: ${toUnicodeMonospace(truncatedCommitId)}`);

    // Status Badges
    if (badges.length > 0) {
        lines.push(`sᴛᴀᴛᴜs: ${badges.join(' ')}`);
    }

    // Date (Author or Committer timestamp)
    const person = commit.author || commit.committer;
    if (person?.timestamp) {
        const { relTime, fullTime } = getPersonDisplayStrings(person);
        lines.push(`ᴅᴀᴛᴇ: ${relTime} (${fullTime})`);
    }

    // Bookmarks, Tags, Working Copies
    if (commit.bookmarks && commit.bookmarks.length > 0) {
        const bms = commit.bookmarks.map((b) => (b.remote ? `${b.name}@${b.remote}` : b.name)).join(', ');
        lines.push(`ʙᴏᴏᴋᴍᴀʀᴋs: ${bms}`);
    }
    if (commit.tags && commit.tags.length > 0) {
        lines.push(`ᴛᴀɢs: ${commit.tags.join(', ')}`);
    }
    if (commit.working_copies && commit.working_copies.length > 0) {
        lines.push(`ᴡᴏʀᴋsᴘᴀᴄᴇs: ${commit.working_copies.join(', ')}`);
    }

    // Divider
    lines.push(DIVIDER);

    // Description
    const desc = commit.description.trim() || '(no description)';
    lines.push(desc);

    return lines.join('\n');
}
