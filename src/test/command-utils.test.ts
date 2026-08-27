/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
    extractBookmarkName,
    maybeFormatDescriptionOnSave,
    RevisionQuery,
    resolveRevisionsWithSelection,
} from '../commands/command-utils';

describe('RevisionQuery', () => {
    it('generates expected revision query strings', () => {
        expect(RevisionQuery.ancestorsExcluding('@')).toBe('ancestors(@) ~ @');
        expect(RevisionQuery.ancestorsIncluding('@')).toBe('ancestors(@)');
        expect(RevisionQuery.mutable()).toBe('mutable()');
        expect(RevisionQuery.visible()).toBe('visible()');
        expect(RevisionQuery.children('rev123')).toBe('children(rev123)');
    });
});

describe('extractBookmarkName', () => {
    it('extracts bookmark name from string argument', () => {
        expect(extractBookmarkName(['  my-bookmark  '])).toBe('my-bookmark');
        expect(extractBookmarkName(['   '])).toBeUndefined();
    });

    it('extracts bookmark name from object with name or bookmarkName property', () => {
        expect(extractBookmarkName([{ name: '  my-bookmark  ' }])).toBe('my-bookmark');
        expect(extractBookmarkName([{ bookmarkName: '  my-bookmark  ' }])).toBe('my-bookmark');
        expect(extractBookmarkName([{ webviewSection: 'jj.bookmark', bookmarkName: 'my-bookmark' }])).toBe(
            'my-bookmark',
        );
        expect(extractBookmarkName([{ name: '   ' }])).toBeUndefined();
        expect(extractBookmarkName([{}])).toBeUndefined();
    });
});

describe('resolveRevisionsWithSelection', () => {
    it('returns selected IDs when clicked target is included in selection', () => {
        const scmProvider = {
            getSelectedCommitIds: () => ['rev1', 'rev2', 'rev3'],
        };
        const result = resolveRevisionsWithSelection(['rev2'], scmProvider);
        expect(result).toEqual(['rev1', 'rev2', 'rev3']);
    });

    it('returns only explicit arg revisions when clicked target is not in selection', () => {
        const scmProvider = {
            getSelectedCommitIds: () => ['rev1', 'rev2'],
        };
        const result = resolveRevisionsWithSelection(['otherRev'], scmProvider);
        expect(result).toEqual(['otherRev']);
    });

    it('returns selected IDs when no explicit revision args are provided', () => {
        const scmProvider = {
            getSelectedCommitIds: () => ['rev1', 'rev2'],
        };
        const result = resolveRevisionsWithSelection([], scmProvider);
        expect(result).toEqual(['rev1', 'rev2']);
    });

    it('falls back to default revision when no args or selection exist', () => {
        expect(resolveRevisionsWithSelection([])).toEqual(['@']);
        expect(resolveRevisionsWithSelection([], undefined, 'root()')).toEqual(['root()']);
    });
});

describe('maybeFormatDescriptionOnSave', () => {
    it('does not format description when commit.formatDescriptionOnSave is disabled', async () => {
        const ctx = {
            host: {
                config: {
                    get: vi.fn().mockImplementation((key: string) => {
                        if (key === 'commit.formatDescriptionOnSave') {
                            return false;
                        }
                        return undefined;
                    }),
                },
            },
        };

        const raw = 'Title\n\nThis is a very long paragraph that will not be wrapped because formatting is off.';
        const result = await maybeFormatDescriptionOnSave(raw, ctx, '@');
        expect(result).toBe(raw);
    });

    it('formats description and updates ctx.host.ui.setScmDescriptionInputValue when revision is @', async () => {
        const setScmDescriptionInputValue = vi.fn();
        const ctx = {
            host: {
                config: {
                    get: vi.fn().mockImplementation((key: string) => {
                        if (key === 'commit.formatDescriptionOnSave') {
                            return true;
                        }
                        if (key === 'commit.bodyWidthRuler') {
                            return 20;
                        }
                        return undefined;
                    }),
                },
                ui: {
                    setScmDescriptionInputValue,
                },
            },
        };

        const raw = 'Title\n\nThis is a long body line that should be wrapped by prettier.';
        const result = await maybeFormatDescriptionOnSave(raw, ctx, '@');

        expect(result).toBe('Title\n\nThis is a long body\nline that should be\nwrapped by prettier.');
        expect(setScmDescriptionInputValue).toHaveBeenCalledWith(result);
    });

    it('formats description but does not call setScmDescriptionInputValue when revision is not @', async () => {
        const setScmDescriptionInputValue = vi.fn();
        const ctx = {
            host: {
                config: {
                    get: vi.fn().mockImplementation((key: string) => {
                        if (key === 'commit.formatDescriptionOnSave') {
                            return true;
                        }
                        if (key === 'commit.bodyWidthRuler') {
                            return 20;
                        }
                        return undefined;
                    }),
                },
                ui: {
                    setScmDescriptionInputValue,
                },
            },
        };

        const raw = 'Title\n\nThis is a long body line that should be wrapped by prettier.';
        const result = await maybeFormatDescriptionOnSave(raw, ctx, '@-');

        expect(result).toBe('Title\n\nThis is a long body\nline that should be\nwrapped by prettier.');
        expect(setScmDescriptionInputValue).not.toHaveBeenCalled();
    });
});
