/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JjScmProvider } from '../jj-scm-provider';
import { showJjError } from './command-utils';

export async function refreshCommand(scmProvider: JjScmProvider) {
    try {
        await scmProvider.refresh({ reason: 'manual refresh command', forceSnapshot: true });
    } catch (err: unknown) {
        showJjError(err, 'Error refreshing', scmProvider.outputChannel);
    }
}
