// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
