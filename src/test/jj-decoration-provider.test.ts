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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { accessPrivate } from './test-utils';
import { JjStatusEntry } from '../jj-types';

// Mock vscode
vi.mock('vscode', () => {
    return {
        EventEmitter: class {
            event = () => {};
            fire = () => {};
            dispose = () => {};
        },
        ThemeColor: class {},
        FileDecoration: class {},
        Uri: {
            parse: (s: string) => ({ toString: () => s }),
            file: (s: string) => ({ toString: () => `file://${s}` }),
        },
    };
});

// Import after mock
import { JjDecorationProvider } from '../jj-decoration-provider';

describe('JjDecorationProvider', () => {
    let provider: JjDecorationProvider;
    let fireSpy: unknown;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        provider = new JjDecorationProvider();

        // Access the private property
        const emitter = accessPrivate(provider, '_onDidChangeFileDecorations');
        fireSpy = vi.spyOn(emitter, 'fire');
    });

    it('should fire event when decorations change', () => {
        const decorations = new Map<string, JjStatusEntry>();
        decorations.set('file:///a', { path: 'a', status: 'modified' });

        provider.setDecorations(decorations);

        expect(fireSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT fire event when decorations are identical', () => {
        const decorations1 = new Map<string, JjStatusEntry>();
        decorations1.set('file:///a', { path: 'a', status: 'modified' });

        provider.setDecorations(decorations1);
        expect(fireSpy).toHaveBeenCalledTimes(1);

        // precise clone
        const decorations2 = new Map<string, JjStatusEntry>();
        decorations2.set('file:///a', { path: 'a', status: 'modified' });

        provider.setDecorations(decorations2);

        // This confirms the fix
        expect(fireSpy).toHaveBeenCalledTimes(1);
    });
});
