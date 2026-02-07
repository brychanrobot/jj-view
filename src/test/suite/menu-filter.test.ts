/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect } from 'vitest';
import { filterMenuActions, MenuAction } from '../../common/menu-filter';

describe('filterMenuActions', () => {
    const actions: MenuAction[] = [
        { label: 'Edit', command: 'edit', requiresMutable: true },
        { label: 'Abandon', command: 'abandon', requiresMutable: true },
        { label: 'Duplicate', command: 'duplicate', requiresMutable: false },
        { label: 'Log', command: 'log', requiresMutable: false },
    ];

    test('should return all actions for mutable commit', () => {
        const result = filterMenuActions(actions, false);
        expect(result.length).toBe(4);
        expect(result.map((a) => a.command)).toEqual(['edit', 'abandon', 'duplicate', 'log']);
    });

    test('should exclude mutable-only actions for immutable commit', () => {
        const result = filterMenuActions(actions, true);
        expect(result.length).toBe(2);
        expect(result.map((a) => a.command)).toEqual(['duplicate', 'log']);
    });

    test('should handle empty actions list', () => {
        const result = filterMenuActions([], true);
        expect(result.length).toBe(0);
    });

    test('should handle actions without requiresMutable (default implicit mutable or immutable?)', () => {
        // Our type requires it, but if passed loose objects...
        const mixedActions: unknown[] = [
            { label: 'Unsafe', command: 'unsafe', requiresMutable: true },
            { label: 'Safe', command: 'safe' }, // undefined implies false/safe usually? Logic says `if (action.requiresMutable && ...)`
        ];

        // If undefined, `undefined && true` is undefined (falsy) -> kept.
        const result = filterMenuActions(mixedActions as MenuAction[], true);
        expect(result.length).toBe(1);
        expect(result[0].command).toBe('safe');
    });
});
