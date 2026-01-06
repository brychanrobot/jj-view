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

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock, asMock } from '../test-utils';
import { refreshCommand } from '../../commands/refresh';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
    window: {
        showErrorMessage: vi.fn(),
    },
}));

describe('refreshCommand', () => {
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        scmProvider = createMock<JjScmProvider>({
            refresh: vi.fn(),
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test('calls refresh successfully', async () => {
        await refreshCommand(scmProvider);
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    test('handles refresh error', async () => {
        asMock(scmProvider.refresh).mockRejectedValue(new Error('refresh failed'));
        await refreshCommand(scmProvider);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Error refreshing: refresh failed'),
        );
    });
});
