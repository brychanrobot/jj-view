/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommitDetailsPayload } from './common/ipc/commit-details-schemas';
import type {
    ActionPayload,
    CommitAction,
    LogViewPayload,
    ToggleableCommitAction,
} from './common/ipc/log-view-schemas';
import { TOGGLEABLE_COMMIT_ACTIONS } from './common/ipc/log-view-schemas';
import type {
    CodeForgeChangeInfo,
    CommitParent,
    JjBookmark,
    JjFileChange,
    JjFileChangeWithStats,
    JjLogEntry,
    JjStatusEntry,
    JjWorkspace,
} from './jj-schemas';

export type {
    ActionPayload,
    CodeForgeChangeInfo,
    CommitAction,
    CommitParent,
    JjBookmark,
    JjFileChange,
    JjFileChangeWithStats,
    JjLogEntry,
    JjStatusEntry,
    JjWorkspace,
    ToggleableCommitAction,
};

export { TOGGLEABLE_COMMIT_ACTIONS };

export type WebviewInitialData =
    | {
          view: 'graph';
          payload?: LogViewPayload;
      }
    | {
          view: 'details';
          payload?: CommitDetailsPayload;
      };
