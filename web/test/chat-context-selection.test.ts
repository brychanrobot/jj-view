/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
    cleanViewerFilename,
    extractViewerRevision,
    formatChatContextMessage,
    formatSelectionBadgeDetail,
    formatSelectionBadgeLabel,
    inferCodeFenceLanguage,
    inferLineRangeFromContent,
    resolveDiffOrFileSelection,
} from '../src/diff/chat-context-selection';

describe('chat-context-selection', () => {
    it('cleans viewer filenames and extracts revision annotations', () => {
        expect(cleanViewerFilename('src/main.ts (Working Copy)')).toBe('src/main.ts');
        expect(extractViewerRevision('src/main.ts (Working Copy)')).toBe('Working Copy');
        expect(extractViewerRevision('src/main.ts (qpvuntsm123456)')).toBe('qpvuntsm');
        expect(cleanViewerFilename('src/main.ts')).toBe('src/main.ts');
        expect(extractViewerRevision('src/main.ts')).toBeUndefined();
    });

    it('infers 1-indexed line ranges from full file content', () => {
        const content = ['line 1', 'line 2', 'const target = 42;', 'return target;', 'line 5'].join('\n');
        expect(inferLineRangeFromContent(content, 'const target = 42;\nreturn target;')).toEqual({
            startLine: 3,
            endLine: 4,
        });
        expect(inferLineRangeFromContent(content, 'target = 42')).toEqual({
            startLine: 3,
            endLine: 3,
        });
        expect(inferLineRangeFromContent(content, 'nonexistent text')).toBeUndefined();
    });

    it('resolves gutter line selections from modified or original content', () => {
        const modifiedContent = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
        const originalContent = ['old-1', 'old-2', 'old-3'].join('\n');

        const additionSel = resolveDiffOrFileSelection({
            filename: 'src/demo.ts (Working Copy)',
            containerEl: null,
            modifiedContent,
            originalContent,
            selectedRanges: [{ startLine: 1, endLine: 2 }],
            selectedLineSide: 'additions',
        });

        expect(additionSel).toEqual({
            filename: 'src/demo.ts',
            fsPath: undefined,
            startLine: 2,
            endLine: 3,
            side: 'additions',
            revision: 'Working Copy',
            selectedText: 'beta\ngamma',
        });

        const deletionSel = resolveDiffOrFileSelection({
            filename: 'src/demo.ts (qpvuntsm)',
            containerEl: null,
            modifiedContent,
            originalContent,
            selectedRanges: [{ startLine: 0, endLine: 1 }],
            selectedLineSide: 'deletions',
        });

        expect(deletionSel).toEqual({
            filename: 'src/demo.ts',
            fsPath: undefined,
            startLine: 1,
            endLine: 2,
            side: 'deletions',
            revision: 'qpvuntsm',
            selectedText: 'old-1\nold-2',
        });
    });

    it('formats selection badge labels, details, and chat messages', () => {
        const selection = {
            filename: 'web/src/App.svelte',
            startLine: 10,
            endLine: 12,
            side: 'additions' as const,
            revision: '@',
            selectedText: 'const x = 1;\nconst y = 2;\nconst z = x + y;',
        };

        expect(formatSelectionBadgeLabel(selection)).toBe('web/src/App.svelte:10-12');
        expect(formatSelectionBadgeDetail(selection)).toBe('working copy (@)');
        expect(inferCodeFenceLanguage('web/src/App.svelte')).toBe('svelte');

        const msgWithPrompt = formatChatContextMessage(selection, 'Refactor this into a helper');
        expect(msgWithPrompt).toBe(
            [
                'Context from `web/src/App.svelte:10-12` (working copy (@)):',
                '```svelte',
                'const x = 1;',
                'const y = 2;',
                'const z = x + y;',
                '```',
                '',
                'Refactor this into a helper',
            ].join('\n'),
        );

        const msgWithoutPrompt = formatChatContextMessage(selection, '   ');
        expect(msgWithoutPrompt).toBe(
            [
                'Context from `web/src/App.svelte:10-12` (working copy (@)):',
                '```svelte',
                'const x = 1;',
                'const y = 2;',
                'const z = x + y;',
                '```',
            ].join('\n'),
        );
    });
});
