/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { JjLogEntry } from '../core/jj-types';
import {
    formatCommitTooltip,
    fromUnicodeBold,
    fromUnicodeMonospace,
    toUnicodeBold,
    toUnicodeMonospace,
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
    describe('toUnicodeBold', () => {
        it('converts ASCII letters and digits to Mathematical Sans-Serif Bold', () => {
            expect(toUnicodeBold('Change:')).toBe('𝗖𝗵𝗮𝗻𝗴𝗲:');
            expect(toUnicodeBold('Commit:')).toBe('𝗖𝗼𝗺𝗺𝗶𝘁:');
            expect(toUnicodeBold('Author 123')).toBe('𝗔𝘂𝘁𝗵𝗼𝗿 𝟭𝟮𝟯');
        });

        it('preserves non-alphanumeric characters', () => {
            expect(toUnicodeBold('• - / : ( )')).toBe('• - / : ( )');
        });

        it('converts Mathematical Sans-Serif Bold Unicode glyphs back to ASCII', () => {
            expect(fromUnicodeBold('𝗖𝗵𝗮𝗻𝗴𝗲: 𝗸𝗸')).toBe('Change: kk');
            expect(fromUnicodeBold('𝗖𝗼𝗺𝗺𝗶𝘁: 𝟬𝟭𝟮')).toBe('Commit: 012');
            expect(fromUnicodeBold(toUnicodeBold('Test 123 ABC xyz'))).toBe('Test 123 ABC xyz');
        });
    });

    describe('toUnicodeMonospace', () => {
        it('converts ASCII letters and digits to Mathematical Monospace', () => {
            expect(toUnicodeMonospace('abcXYZ012')).toBe('𝚊𝚋𝚌𝚇𝚈𝚉𝟶𝟷𝟸');
        });

        it('preserves non-alphanumeric characters', () => {
            expect(toUnicodeMonospace('• - / : ( )')).toBe('• - / : ( )');
        });

        it('converts Mathematical Monospace Unicode glyphs back to ASCII', () => {
            expect(fromUnicodeMonospace('𝚊𝚋𝚌𝚇𝚈𝚉𝟶𝟷𝟸')).toBe('abcXYZ012');
            expect(fromUnicodeMonospace(toUnicodeMonospace('Change/0 123'))).toBe('Change/0 123');
        });
    });

    describe('formatCommitTooltip', () => {
        it('formats small caps labels, bold shortest prefix, monospace hashes, divider, and full body', () => {
            const commit = createMockCommit({ author: undefined, committer: undefined });
            const tooltip = formatCommitTooltip(commit);

            expect(tooltip).toBe(
                [
                    'ᴄʜᴀɴɢᴇ: 𝗸𝗸𝚖𝚙𝚙𝚝𝚡𝚣𝚊𝚋',
                    'ᴄᴏᴍᴍɪᴛ: 𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿',
                    '────────────────────────────────────────',
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
            expect(tooltip).toContain('────────────────────────────────────────');
        });

        it('includes status badges for conflict, divergent, working copy, empty, and immutable', () => {
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

            expect(tooltip).toContain('sᴛᴀᴛᴜs: @ (working copy) (empty) ⚠️ (conflict) ⑂ (divergent) 🔒 (immutable)');
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
                    'ᴄʜᴀɴɢᴇ: 𝗸𝗸𝚖𝚙𝚙𝚝𝚡𝚣𝚊𝚋',
                    'ᴄᴏᴍᴍɪᴛ: 𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿',
                    'ʙᴏᴏᴋᴍᴀʀᴋs: main, push-feat@origin',
                    'ᴛᴀɢs: v1.2.0',
                    'ᴡᴏʀᴋsᴘᴀᴄᴇs: default',
                    '────────────────────────────────────────',
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
