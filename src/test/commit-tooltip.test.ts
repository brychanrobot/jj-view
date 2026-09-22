/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { JjLogEntry } from '../core/jj-types';
import {
    DIVIDER,
    formatCommitTooltip,
    fromUnicodeSansBold,
    fromUnicodeSansRegular,
    toUnicodeSansBold,
    toUnicodeSansRegular,
} from '../core/webview/log/utils/commit-tooltip';

function createMockCommit(overrides: Partial<JjLogEntry> = {}): JjLogEntry {
    const timestamp = new Date(Date.now() - 3600 * 1000 * 2).toISOString(); // 2 hours ago
    return {
        change_id: 'kkmpptxzabcdef0123456789',
        change_id_shortest: 'kk',
        commit_id: '0123456789abcdef0123456789abcdef01234567',
        description: 'feat: add feature\n\nDetailed body explanation.',
        author: {
            name: 'Bryant Chandler',
            email: 'bryant@example.com',
            timestamp,
        },
        committer: {
            name: 'Bryant Chandler',
            email: 'bryant@example.com',
            timestamp,
        },
        parents: [],
        bookmarks: [],
        tags: [],
        working_copies: [],
        ...overrides,
    };
}

describe('commit-tooltip', () => {
    describe('toUnicodeSansBold', () => {
        it('converts ASCII letters and digits to Mathematical Sans-Serif Bold', () => {
            expect(toUnicodeSansBold('Change:')).toBe('𝗖𝗵𝗮𝗻𝗴𝗲:');
            expect(toUnicodeSansBold('Commit:')).toBe('𝗖𝗼𝗺𝗺𝗶𝘁:');
            expect(toUnicodeSansBold('Author 123')).toBe('𝗔𝘂𝘁𝗵𝗼𝗿 𝟭𝟮𝟯');
        });

        it('preserves non-alphanumeric characters', () => {
            expect(toUnicodeSansBold('• - / : ( )')).toBe('• - / : ( )');
        });

        it('converts Mathematical Sans-Serif Bold Unicode glyphs back to ASCII', () => {
            expect(fromUnicodeSansBold('𝗖𝗵𝗮𝗻𝗴𝗲: 𝗸𝗸')).toBe('Change: kk');
            expect(fromUnicodeSansBold('𝗖𝗼𝗺𝗺𝗶𝘁: 𝟬𝟭𝟮')).toBe('Commit: 012');
            expect(fromUnicodeSansBold(toUnicodeSansBold('Test 123 ABC xyz'))).toBe('Test 123 ABC xyz');
        });
    });

    describe('toUnicodeSansRegular', () => {
        it('converts ASCII letters and digits to Mathematical Sans-Serif Regular', () => {
            expect(toUnicodeSansRegular('abcXYZ012')).toBe('𝖺𝖻𝖼𝖷𝖸𝖹𝟢𝟣𝟤');
        });

        it('preserves non-alphanumeric characters', () => {
            expect(toUnicodeSansRegular('• - / : ( )')).toBe('• - / : ( )');
        });

        it('converts Mathematical Sans-Serif Regular Unicode glyphs back to ASCII', () => {
            expect(fromUnicodeSansRegular('𝖺𝖻𝖼𝖷𝖸𝖹𝟢𝟣𝟤')).toBe('abcXYZ012');
            expect(fromUnicodeSansRegular(toUnicodeSansRegular('Change/0 123'))).toBe('Change/0 123');
        });
    });

    describe('formatCommitTooltip', () => {
        it('formats small caps labels, bold shortest prefix, sans-serif regular hashes, divider, and full body', () => {
            const commit = createMockCommit({ author: undefined, committer: undefined });
            const tooltip = formatCommitTooltip(commit);

            expect(tooltip).toBe(
                [
                    'ᴄʜᴀɴɢᴇ: 𝗸𝗸𝗆𝗉𝗉𝗍𝗑𝗓𝖺𝖻',
                    'ᴄᴏᴍᴍɪᴛ: 𝟢𝟣𝟤𝟥𝟦𝟧𝟨𝟩𝟪𝟫',
                    DIVIDER,
                    'feat: add feature',
                    '',
                    'Detailed body explanation.',
                ].join('\n'),
            );
        });

        it('includes date when author timestamp is present', () => {
            const commit = createMockCommit();
            const tooltip = formatCommitTooltip(commit);

            expect(tooltip).toContain('ᴅᴀᴛᴇ: 2 hours ago');
            expect(tooltip).toContain(DIVIDER);
        });

        it('does not include status line for working copy, empty, conflict, divergent, or immutable commits', () => {
            const commit = createMockCommit({
                author: undefined,
                committer: undefined,
                is_current_working_copy: true,
                is_empty: true,
                conflict: true,
                is_divergent: true,
                is_immutable: true,
            });
            const tooltip = formatCommitTooltip(commit);

            expect(tooltip).not.toContain('sᴛᴀᴛᴜs:');
            expect(tooltip).not.toContain('(working copy)');
            expect(tooltip).not.toContain('(immutable)');
        });

        it('includes bookmarks, tags, and working copies', () => {
            const commit = createMockCommit({
                author: undefined,
                committer: undefined,
                bookmarks: [{ name: 'main' }, { name: 'push-feat', remote: 'origin' }],
                tags: ['v1.2.0'],
                working_copies: ['default'],
            });
            const tooltip = formatCommitTooltip(commit);

            expect(tooltip).toBe(
                [
                    'ᴄʜᴀɴɢᴇ: 𝗸𝗸𝗆𝗉𝗉𝗍𝗑𝗓𝖺𝖻',
                    'ᴄᴏᴍᴍɪᴛ: 𝟢𝟣𝟤𝟥𝟦𝟧𝟨𝟩𝟪𝟫',
                    'ʙᴏᴏᴋᴍᴀʀᴋs: main, push-feat@origin',
                    'ᴛᴀɢs: v1.2.0',
                    'ᴡᴏʀᴋsᴘᴀᴄᴇs: default',
                    DIVIDER,
                    'feat: add feature',
                    '',
                    'Detailed body explanation.',
                ].join('\n'),
            );
        });

        it('uses fallback text for empty description', () => {
            const commit = createMockCommit({
                author: undefined,
                committer: undefined,
                description: '   ',
            });
            const tooltip = formatCommitTooltip(commit);

            expect(tooltip).toContain('(no description)');
        });
    });
});
